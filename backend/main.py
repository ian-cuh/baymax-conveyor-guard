"""
Smart Conveyor Guard — Backend
--------------------------------------------------------
Real sensors on this build: MPU6050 (vibration), HX711 + strain gauge
(tension), IR proximity sensor (speed). No temperature sensor yet —
temperature_c is optional and, if the ESP32 doesn't send it, is treated
as "unknown" rather than faked.

  ESP32 -> MQTT (topic: conveyor/<joint_id>/telemetry) -> this FastAPI
  service -> WebSocket -> React dashboard (ConveyorDashboard.jsx)

Run:
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8000
"""

import asyncio
import itertools
import json
import os
import random
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

import paho.mqtt.client as mqtt
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "conveyor/+/telemetry")

VIBRATION_WARN_G = 0.7
VIBRATION_CRIT_G = 1.0
TENSION_LOW_KN = 3.0
TEMP_WARN_C = 55.0
TEMP_CRIT_C = 75.0

# Same alert type shouldn't re-fire for the same joint more than once per
# this many seconds, so one ongoing issue doesn't spam the Alerts panel.
ALERT_COOLDOWN_SECONDS = 60

app = FastAPI(title="Smart Conveyor Guard API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# Data model — JSON contract the ESP32 firmware publishes.
# temperature_c is optional: this build has no temperature sensor.
# --------------------------------------------------------------------------
class SensorReading(BaseModel):
    joint_id: str
    vibration_g: float
    tension_kn: float
    temperature_c: Optional[float] = None
    speed_mps: float
    timestamp: str = None


# Each rule maps to ONE specific, actionable precaution — not a vague label.
# alert_type is used for dedup/cooldown and for matching "resolved" events.
RULES = [
    {
        "alert_type": "vibration_critical",
        "check": lambda r: r.vibration_g >= VIBRATION_CRIT_G,
        "level": "critical",
        "issue": "Vibration critical",
        "precaution": (
            "Stop the belt and physically inspect this joint immediately. "
            "Severe vibration usually means a damaged/misaligned idler roller "
            "or a developing joint tear — running further risks a full rupture."
        ),
    },
    {
        "alert_type": "vibration_warning",
        "check": lambda r: VIBRATION_WARN_G <= r.vibration_g < VIBRATION_CRIT_G,
        "level": "warning",
        "issue": "Vibration elevated",
        "precaution": (
            "Schedule an inspection of idler rollers and belt alignment near "
            "this joint within the next shift. Uneven loading is a common cause."
        ),
    },
    {
        "alert_type": "tension_low",
        "check": lambda r: r.tension_kn <= TENSION_LOW_KN,
        "level": "critical",
        "issue": "Tension too low — possible slip",
        "precaution": (
            "Check the belt tensioner and this joint's splice for slippage. "
            "Low tension can cause belt slip, mistracking, and spillage."
        ),
    },
    {
        "alert_type": "temperature_critical",
        "check": lambda r: r.temperature_c is not None and r.temperature_c >= TEMP_CRIT_C,
        "level": "critical",
        "issue": "Temperature critical — fire risk",
        "precaution": (
            "Reduce belt speed or stop immediately. Sustained friction heat at "
            "a joint is a known fire-start cause in iron ore conveyors."
        ),
    },
    {
        "alert_type": "temperature_warning",
        "check": lambda r: r.temperature_c is not None and TEMP_WARN_C <= r.temperature_c < TEMP_CRIT_C,
        "level": "warning",
        "issue": "Temperature rising",
        "precaution": (
            "Monitor closely — rising temperature at a joint often precedes "
            "friction damage. Check for material buildup or misalignment."
        ),
    },
]


def score_reading(r: SensorReading) -> dict:
    """
    Explainable rule-based scoring. Runs every rule (not just the first
    match) so a reading can trigger multiple simultaneous alerts, and the
    overall level is the worst of all triggered rules.
    """
    triggered = [rule for rule in RULES if rule["check"](r)]

    if any(t["level"] == "critical" for t in triggered):
        level = "critical"
    elif any(t["level"] == "warning" for t in triggered):
        level = "warning"
    else:
        level = "ok"

    reasons = [t["issue"] for t in triggered]

    penalty = int(r.vibration_g * 40)
    if r.temperature_c is not None and r.temperature_c > 40:
        penalty += int(r.temperature_c - 40)
    if r.tension_kn < 4.0:
        penalty += int((4.0 - r.tension_kn) * 15)
    health = max(0, min(100, 100 - penalty))

    return {"level": level, "reasons": reasons, "health": health, "triggered": triggered}


# --------------------------------------------------------------------------
# State: recent readings, alerts (open + resolved), websocket connections
# --------------------------------------------------------------------------
recent_readings: Dict[str, List[dict]] = {}
active_connections: List[WebSocket] = []
main_loop: asyncio.AbstractEventLoop = None

alert_counter = itertools.count(1)
open_alerts: Dict[str, dict] = {}     # key: f"{joint_id}:{alert_type}" -> alert dict
resolved_alerts: List[dict] = []
_last_fired: Dict[str, float] = {}    # key -> epoch seconds, for cooldown


def save_reading(payload: dict):
    """Persist a scored reading. Swap for InfluxDB/Firebase if you want history beyond memory."""
    bucket = recent_readings.setdefault(payload["joint_id"], [])
    bucket.append(payload)
    recent_readings[payload["joint_id"]] = bucket[-200:]


def _human_time():
    return datetime.now(timezone.utc).isoformat()


def process_alerts(joint_id: str, joint_name: str, score: dict) -> List[dict]:
    """
    Compares this reading's triggered rules against currently-open alerts
    for this joint: opens new ones (respecting cooldown), and resolves any
    open alert whose rule is no longer triggering.
    """
    events = []
    now = time.time()
    triggered_types = {t["alert_type"] for t in score["triggered"]}

    # Open new alerts for newly-triggered rules
    for rule in score["triggered"]:
        key = f"{joint_id}:{rule['alert_type']}"
        last = _last_fired.get(key)
        if key in open_alerts:
            continue  # already open, don't duplicate
        if last is not None and (now - last) < ALERT_COOLDOWN_SECONDS:
            continue  # still cooling down from a very recent resolve

        alert = {
            "id": next(alert_counter),
            "joint_id": joint_id,
            "joint": joint_name,
            "alert_type": rule["alert_type"],
            "issue": rule["issue"],
            "precaution": rule["precaution"],
            "level": rule["level"],
            "time": _human_time(),
            "status": "open",
        }
        open_alerts[key] = alert
        _last_fired[key] = now
        events.append({"type": "alert_opened", "alert": alert})

    # Resolve alerts whose rule stopped triggering
    for key in list(open_alerts.keys()):
        alert_joint_id, alert_type = key.split(":", 1)
        if alert_joint_id != joint_id:
            continue
        if alert_type not in triggered_types:
            resolved = open_alerts.pop(key)
            resolved = {
                **resolved,
                "status": "resolved",
                "issue": f"{resolved['issue']} — resolved",
                "precaution": "Condition returned to normal range. No further action needed unless it recurs.",
                "time": _human_time(),
            }
            resolved_alerts.insert(0, resolved)
            del resolved_alerts[200:]  # cap memory
            events.append({"type": "alert_resolved", "alert": resolved})

    return events


async def broadcast(payload: dict):
    dead = []
    for ws in active_connections:
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            dead.append(ws)
    for d in dead:
        active_connections.remove(d)


# --------------------------------------------------------------------------
# MQTT client
# --------------------------------------------------------------------------
def on_connect(client, userdata, flags, rc, properties=None):
    print(f"[MQTT] connected rc={rc}, subscribing to {MQTT_TOPIC}")
    client.subscribe(MQTT_TOPIC)


def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode())
        reading = SensorReading(**data)
        if not reading.timestamp:
            reading.timestamp = datetime.now(timezone.utc).isoformat()

        score = score_reading(reading)
        payload = {**reading.model_dump(), **{k: v for k, v in score.items() if k != "triggered"}}
        save_reading(payload)

        joint_name = JOINT_NAMES.get(reading.joint_id, reading.joint_id)
        alert_events = process_alerts(reading.joint_id, joint_name, score)

        if main_loop:
            asyncio.run_coroutine_threadsafe(
                broadcast({"type": "telemetry", **payload}), main_loop
            )
            for ev in alert_events:
                asyncio.run_coroutine_threadsafe(broadcast(ev), main_loop)

    except Exception as e:
        print(f"[MQTT] bad message on {msg.topic}: {e}")


# Display names for known joints — extend this if you add more joints.
JOINT_NAMES = {"J1": "Joint 1"}

mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
mqtt_client.on_connect = on_connect
mqtt_client.on_message = on_message


@app.on_event("startup")
async def startup():
    global main_loop
    main_loop = asyncio.get_event_loop()
    mqtt_client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    mqtt_client.loop_start()


@app.on_event("shutdown")
async def shutdown():
    mqtt_client.loop_stop()
    mqtt_client.disconnect()


# --------------------------------------------------------------------------
# REST endpoints
# --------------------------------------------------------------------------
@app.get("/api/joints")
def list_joints():
    return {jid: readings[-1] for jid, readings in recent_readings.items() if readings}


@app.get("/api/joints/{joint_id}/history")
def joint_history(joint_id: str, limit: int = 100):
    return recent_readings.get(joint_id, [])[-limit:]


@app.get("/api/alerts")
def list_alerts(status: str = "open"):
    """status: 'open' (currently active) or 'resolved' (history)."""
    if status == "resolved":
        return resolved_alerts[:100]
    return sorted(open_alerts.values(), key=lambda a: a["time"], reverse=True)


@app.post("/api/ingest")
async def http_ingest(reading: SensorReading):
    """Fallback ingestion path for sensors that can't do MQTT (plain HTTP POST)."""
    if not reading.timestamp:
        reading.timestamp = datetime.now(timezone.utc).isoformat()
    score = score_reading(reading)
    payload = {**reading.model_dump(), **{k: v for k, v in score.items() if k != "triggered"}}
    save_reading(payload)
    joint_name = JOINT_NAMES.get(reading.joint_id, reading.joint_id)
    alert_events = process_alerts(reading.joint_id, joint_name, score)

    await broadcast({"type": "telemetry", **payload})
    for ev in alert_events:
        await broadcast(ev)

    return {"ok": True, "scored": {k: v for k, v in score.items() if k != "triggered"}}


# --------------------------------------------------------------------------
# DEMO MODE — scripted, deterministic readings for a recorded demonstration.
# This bypasses real sensors entirely and feeds canned values through the
# exact same scoring/alert/broadcast pipeline, so alerts on the dashboard
# are real (auto-open, real precaution text, auto-resolve later) — only the
# input numbers are staged for a controllable recording.
# --------------------------------------------------------------------------
DEMO_JOINT_ID = "J1"
DEMO_JOINT_NAME = JOINT_NAMES.get(DEMO_JOINT_ID, DEMO_JOINT_ID)

DEMO_ROUNDS = {
    1: SensorReading(  # Round 1: temperature climbing, everything else normal
        joint_id=DEMO_JOINT_ID, vibration_g=0.32, tension_kn=4.4,
        temperature_c=62.0, speed_mps=1.18,
    ),
    2: SensorReading(  # Round 2: vibration AND temperature both critical together
        joint_id=DEMO_JOINT_ID, vibration_g=1.15, tension_kn=4.1,
        temperature_c=79.0, speed_mps=1.05,
    ),
}

# How long to wait after the curl command before the alert actually appears
# on screen — gives you time to switch from terminal to phone/dashboard
# before it shows up, so the recording looks like it's happening live.
DEMO_DELAY_SECONDS = 5


async def _do_round(n: int):
    reading = DEMO_ROUNDS[n]
    reading.timestamp = datetime.now(timezone.utc).isoformat()

    score = score_reading(reading)
    payload = {**reading.model_dump(), **{k: v for k, v in score.items() if k != "triggered"}}
    save_reading(payload)
    alert_events = process_alerts(reading.joint_id, DEMO_JOINT_NAME, score)

    await broadcast({"type": "telemetry", **payload})
    for ev in alert_events:
        await broadcast(ev)


async def _do_tear():
    key = f"{DEMO_JOINT_ID}:visual_tear_detected"
    alert = {
        "id": next(alert_counter),
        "joint_id": DEMO_JOINT_ID,
        "joint": DEMO_JOINT_NAME,
        "alert_type": "visual_tear_detected",
        "issue": "Belt tear detected (camera)",
        "precaution": (
            "Stop the belt immediately. Visual inspection confirms physical "
            "damage at this joint — do not resume operation until repaired."
        ),
        "level": "critical",
        "time": _human_time(),
        "status": "open",
    }
    open_alerts[key] = alert
    _last_fired[key] = time.time()
    await broadcast({"type": "alert_opened", "alert": alert})


@app.post("/api/demo/round/{n}")
async def demo_round(n: int):
    """
    n=1 -> temperature rising (warning)
    n=2 -> vibration + temperature critical together (multi-parameter alert)
    n=3 -> reserved; the physical tear is reported by the camera tab via
           /api/demo/tear instead, since it's a visual event, not a sensor one.

    Responds immediately; the actual reading/alert is broadcast
    DEMO_DELAY_SECONDS later in the background.
    """
    if n not in DEMO_ROUNDS:
        return {"ok": False, "error": "round must be 1 or 2 (use /api/demo/tear for round 3)"}

    async def delayed():
        await asyncio.sleep(DEMO_DELAY_SECONDS)
        await _do_round(n)

    asyncio.create_task(delayed())
    return {"ok": True, "round": n, "fires_in_seconds": DEMO_DELAY_SECONDS}


@app.post("/api/demo/tear")
async def demo_tear():
    """
    Round 3: the camera tab calls this when the belt is physically torn on
    camera. Responds immediately; the actual tear alert appears
    DEMO_DELAY_SECONDS later in the background.
    """
    async def delayed():
        await asyncio.sleep(DEMO_DELAY_SECONDS)
        await _do_tear()

    asyncio.create_task(delayed())
    return {"ok": True, "fires_in_seconds": DEMO_DELAY_SECONDS}


@app.post("/api/demo/reset")
async def demo_reset():
    """Stops any running scripted demo, clears all readings/alerts, and puts J1 (and the
    belt) back in a clean normal state — handy between takes. Immediate (no delay)."""
    await _cancel_demo()
    recent_readings.clear()
    open_alerts.clear()
    resolved_alerts.clear()
    _last_fired.clear()
    belt_state.clear()
    belt_state.update(_belt_default())
    belt_state.update(state="running", message="Belt running normally")

    # Tell every open dashboard tab to wipe its alert lists / chart too.
    await broadcast({"type": "demo_reset"})
    await _push_reading(0.3, 4.5, 35.0, 1.2, apply_rules=False)
    await broadcast({"type": "belt_status", **belt_state})
    return {"ok": True, "message": "Demo reset to normal baseline"}


# ==========================================================================
# SCRIPTED BELT-ROUND DEMOS (1-4)  ->  POST /api/demo/run/{n}
#
# Each demo is a fully scripted (rounds x ROUND_SECONDS, default 8s/round) story that plays out "belt rounds"
# (one round = one full loop of the belt past the inspection point). Readings go
# through the same scoring/broadcast pipeline as real data. Besides telemetry and
# alerts, the backend broadcasts a `belt_status` event (state, round, tear size,
# verification progress) that drives the "Belt Inspection" card + banner on the
# dashboard.
#
#   1  Quiet run: a few small vibration blips, then temperature rising warning.
#   2  Tear detected -> verified over 3 more rounds -> confirmed -> belt STOPS + alert.
#   3  Small tear (warning, belt keeps running) -> next round tear is ~16x bigger
#      than round 1 -> belt STOPS + critical alert.
#   4  (bonus) Tear "detected" but does NOT persist on re-check -> false alarm,
#      alert clears and the belt keeps running (the "otherwise continue" branch).
# ==========================================================================
# ---- DEMO TIMING: change ROUND_SECONDS to lengthen/shorten every demo ----------
# One belt round = ROUND_SECONDS. Demo length = (number of rounds) x ROUND_SECONDS.
# e.g. 3 verification rounds x 8 s = 24 s. Override without editing code:
#   DEMO_ROUND_SECONDS=10 docker compose up --build
ROUND_SECONDS = float(os.environ.get("DEMO_ROUND_SECONDS", "8"))
TICKS_PER_ROUND = 4       # readings pushed per round (a chart point every ROUND_SECONDS/4)
TAIL_SECONDS = 4.0        # how long the "belt stopped" screen lingers at the end
VERIFY_ROUNDS = 3         # rounds the system re-checks a suspected tear before acting
DEMO_TASK: Optional[asyncio.Task] = None


def _belt_default() -> dict:
    return {
        "demo": None,               # which demo is playing (1-4) or None
        "state": "idle",            # idle | running | warning | verifying | stopped
        "round": 0,
        "message": "Belt idle — waiting for data",
        "tear_mm": None,            # latest tear size
        "first_tear_mm": None,      # tear size from the first sighting (for comparison)
        "growth_x": None,           # latest / first
        "verify_done": 0,           # verification rounds completed so far
        "verify_total": 0,          # 0 when not verifying
        "finished": False,          # scripted demo has played to the end
    }


belt_state: dict = _belt_default()


async def _set_belt(**changes):
    belt_state.update(changes)
    await broadcast({"type": "belt_status", **belt_state})


async def _push_reading(vib, tension, temp, speed, apply_rules: bool):
    """Publish one reading. apply_rules=True also runs the normal rule engine (opens/
    resolves vibration/temperature alerts); False keeps the Alerts panel limited to the
    scripted tear alerts so the recording stays easy to follow."""
    reading = SensorReading(
        joint_id=DEMO_JOINT_ID,
        vibration_g=round(max(0.0, vib + random.uniform(-0.02, 0.02)), 2),
        tension_kn=round(tension + random.uniform(-0.05, 0.05), 2),
        temperature_c=round(temp, 1),
        speed_mps=round(max(0.0, speed + (random.uniform(-0.02, 0.02) if speed else 0)), 2),
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    score = score_reading(reading)
    payload = {**reading.model_dump(), **{k: v for k, v in score.items() if k != "triggered"}}
    save_reading(payload)
    await broadcast({"type": "telemetry", **payload})
    if apply_rules:
        for ev in process_alerts(reading.joint_id, DEMO_JOINT_NAME, score):
            await broadcast(ev)


async def _open_demo_alert(alert_type: str, level: str, issue: str, precaution: str):
    key = f"{DEMO_JOINT_ID}:{alert_type}"
    alert = {
        "id": next(alert_counter),
        "joint_id": DEMO_JOINT_ID,
        "joint": DEMO_JOINT_NAME,
        "alert_type": alert_type,
        "issue": issue,
        "precaution": precaution,
        "level": level,
        "time": _human_time(),
        "status": "open",
    }
    open_alerts[key] = alert
    _last_fired[key] = time.time()
    await broadcast({"type": "alert_opened", "alert": alert})


async def _resolve_demo_alert(alert_type: str, note: str):
    alert = open_alerts.pop(f"{DEMO_JOINT_ID}:{alert_type}", None)
    if not alert:
        return
    resolved = {
        **alert,
        "status": "resolved",
        "issue": f"{alert['issue']} — resolved",
        "precaution": note,
        "time": _human_time(),
    }
    resolved_alerts.insert(0, resolved)
    del resolved_alerts[200:]
    await broadcast({"type": "alert_resolved", "alert": resolved})


async def _cancel_demo():
    global DEMO_TASK
    if DEMO_TASK and not DEMO_TASK.done():
        DEMO_TASK.cancel()
        try:
            await DEMO_TASK
        except (asyncio.CancelledError, Exception):
            pass
    DEMO_TASK = None


async def _wipe_for_new_demo():
    """Every demo starts from a clean slate so back-to-back takes don't overlap."""
    recent_readings.clear()
    open_alerts.clear()
    resolved_alerts.clear()
    _last_fired.clear()
    belt_state.clear()
    belt_state.update(_belt_default())
    await broadcast({"type": "demo_reset"})


# ---- Timing helper: ONE ROUND = ROUND_SECONDS, readings spread evenly across it ----
async def _round(readings, apply_rules: bool = False):
    """Play one full belt round. `readings` = list of (vib, tension, temp, speed).
    They are pushed evenly so the whole round lasts exactly ROUND_SECONDS."""
    step = ROUND_SECONDS / len(readings)
    for vib, ten, temp, spd in readings:
        await _push_reading(vib, ten, temp, spd, apply_rules=apply_rules)
        await asyncio.sleep(step)


def _clean(n=TICKS_PER_ROUND, temp=38.0):
    return [(0.31 + 0.01 * (i % 3), 4.5, temp, 1.2) for i in range(n)]


# ---- Demo 1: quiet run, a few vibration blips, then temperature rising ----------
# 5 rounds x ROUND_SECONDS (8s) = 40s
async def _demo_1():
    rounds = 5
    total = rounds * TICKS_PER_ROUND
    blips = {5, 10, 16}   # reading indexes with a small vibration blip
    idx = 0
    for rnd in range(1, rounds + 1):
        if belt_state["state"] != "warning":
            await _set_belt(state="running", round=rnd, message=f"Round {rnd} — belt running normally")
        else:
            await _set_belt(round=rnd)
        step = ROUND_SECONDS / TICKS_PER_ROUND
        for _ in range(TICKS_PER_ROUND):
            temp = 38.0 + 25.0 * idx / (total - 1)          # 38 C -> 63 C
            vib = random.uniform(0.49, 0.58) if idx in blips else 0.31 + 0.01 * (idx % 4)
            await _push_reading(vib, 4.5 if vib < 0.45 else 4.4, temp, 1.2, apply_rules=True)
            if temp >= 55.0 and belt_state["state"] != "warning":
                await _set_belt(
                    state="warning",
                    message="Temperature rising at Joint 1 — belt still running, monitor closely",
                )
            idx += 1
            await asyncio.sleep(step)


# ---- Demo 2 / 4: tear spotted -> verify over 3 rounds -> confirm (2) or clear (4) -
# Demo 2: 2 rounds + 3 verify rounds = 5 x 8s = 40s (verification alone = 3 x 8 = 24s)
# Demo 4: 2 rounds + 2 verify rounds (tear gone) + 1 round running = 5 x 8s = 40s
async def _demo_tear_verification(confirm: bool):
    # Round 1: clean
    await _set_belt(state="running", round=1, message="Round 1 — belt running normally")
    await _round(_clean())

    # Round 2: clean, tear candidate spotted at the END of the round
    await _set_belt(round=2, message="Round 2 — belt running normally")
    await _round(_clean())
    await _push_reading(0.95, 3.7, 38.5, 1.15, apply_rules=False)
    await _set_belt(
        state="verifying", tear_mm=12, first_tear_mm=12, growth_x=1.0,
        verify_done=0, verify_total=VERIFY_ROUNDS,
        message=f"Possible tear detected — verifying over the next {VERIFY_ROUNDS} rounds",
    )
    await _open_demo_alert(
        "tear_suspected", "warning",
        f"Possible tear detected — verifying over {VERIFY_ROUNDS} rounds",
        "The belt is still running while the system re-checks this spot for the next "
        f"{VERIFY_ROUNDS} rounds. Have an operator ready to inspect Joint 1 if it is confirmed.",
    )

    # Verification rounds (each one is a full ROUND_SECONDS)
    for n in range(1, VERIFY_ROUNDS + 1):
        rnd = 2 + n
        await _set_belt(round=rnd, message=f"Round {rnd} — re-checking suspected tear ({n}/{VERIFY_ROUNDS})")
        still_there = confirm or n < 2   # demo 4: tear seen in check 1, gone in check 2
        if still_there:
            await _round([(0.90, 3.7, 38.5, 1.15), (0.92, 3.7, 38.5, 1.15),
                          (0.94, 3.6, 38.5, 1.15), (0.95, 3.6, 38.5, 1.15)])
        else:
            await _round(_clean(temp=38.0))

        if not still_there:
            await _resolve_demo_alert(
                "tear_suspected",
                "Tear not present on re-check — false alarm. Belt kept running, no action needed.",
            )
            await _set_belt(
                state="running", tear_mm=None, first_tear_mm=None, growth_x=None,
                verify_done=0, verify_total=0,
                message="False alarm — tear did not persist on re-check. Belt running normally",
            )
            # one more normal round so the "keeps running" outcome is visible
            await _set_belt(round=rnd + 1)
            await _round(_clean())
            return

        await _set_belt(verify_done=n, message=f"Tear still present — verified {n}/{VERIFY_ROUNDS} rounds")

    # Confirmed after all verification rounds -> stop the belt + alert the dashboard
    await _set_belt(
        state="stopped",
        message=f"TEAR CONFIRMED after {VERIFY_ROUNDS} rounds — belt stopped. Check Joint 1 for the tear",
    )
    await _open_demo_alert(
        "tear_confirmed", "critical",
        "Tear confirmed — belt stopped, check for tear",
        f"The tear persisted through all {VERIFY_ROUNDS} verification rounds. The belt has been stopped "
        "automatically. Go to Joint 1 and inspect the belt for a physical tear before restarting.",
    )
    await _resolve_demo_alert("tear_suspected", "Escalated: tear confirmed, see the critical alert.")
    for _ in range(2):
        await _push_reading(0.06, 3.0, 38.5, 0.0, apply_rules=False)
        await asyncio.sleep(TAIL_SECONDS / 2)


# ---- Demo 3: small tear (warning) -> next round exponentially bigger -> STOP ----
# 2 rounds x 8s + short stopped tail = ~20s
async def _demo_3():
    small_mm, big_mm = 3, 48
    # Round 1: small tear seen at the end of the round.
    await _set_belt(state="running", round=1, message="Round 1 — belt running normally")
    await _round([(0.31, 4.5, 38.0, 1.2), (0.33, 4.5, 38.0, 1.2),
                  (0.36, 4.5, 38.0, 1.2), (0.40, 4.4, 38.0, 1.2)])

    await _push_reading(0.62, 4.2, 38.0, 1.18, apply_rules=False)
    await _set_belt(
        state="warning", tear_mm=small_mm, first_tear_mm=small_mm, growth_x=1.0,
        message=f"Round 1 — small tear detected ({small_mm} mm). Belt keeps running, comparing next round",
    )
    await _open_demo_alert(
        "tear_small", "warning",
        f"Small tear detected ({small_mm} mm) — monitoring",
        "A small tear was spotted on this joint. The belt is still running while the next round "
        "is compared against this one. Plan an inspection; the belt will stop automatically if the tear grows.",
    )

    # Round 2: tear is now exponentially bigger.
    await _set_belt(round=2, message="Round 2 — comparing against Round 1")
    await _round([(0.60, 4.3, 38.5, 1.15), (0.85, 3.8, 38.5, 1.15),
                  (1.10, 3.3, 38.5, 1.10), (1.25, 3.0, 38.8, 1.05)])

    growth = round(big_mm / small_mm, 1)
    await _push_reading(1.35, 2.6, 39.0, 1.0, apply_rules=False)
    await _set_belt(
        state="stopped", tear_mm=big_mm, growth_x=growth,
        message=f"Tear grew {small_mm} mm → {big_mm} mm (x{growth:g}) in one round — belt STOPPED",
    )
    await _open_demo_alert(
        "tear_growth_stop", "critical",
        f"Tear grew x{growth:g} in one round ({small_mm} → {big_mm} mm) — belt stopped",
        "The tear expanded exponentially compared with Round 1, so the belt was stopped automatically "
        "to prevent a full rupture. Inspect and repair Joint 1 before restarting.",
    )
    for _ in range(2):
        await asyncio.sleep(TAIL_SECONDS / 2)
        await _push_reading(0.06, 3.0, 39.0, 0.0, apply_rules=False)


DEMOS = {
    1: ("Quiet run, then temperature rising", _demo_1),
    2: ("Tear detected, verified over 3 rounds, belt stops", lambda: _demo_tear_verification(True)),
    3: ("Small tear warning, then tear x16 bigger, belt stops", _demo_3),
    4: ("False alarm: tear does not persist, belt keeps running", lambda: _demo_tear_verification(False)),
}


async def _run_demo(n: int, delay: float):
    try:
        if delay > 0:
            await asyncio.sleep(delay)
        await _wipe_for_new_demo()
        await _set_belt(demo=n)
        await DEMOS[n][1]()
        await _set_belt(finished=True)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # never leave the demo half-dead silently
        print(f"[DEMO {n}] failed: {e}")


@app.post("/api/demo/run/{n}")
async def demo_run(n: int, delay: float = 0.0):
    """Start scripted demo n (1-4). Each takes roughly 20-40 seconds (rounds x ROUND_SECONDS). `delay` = optional seconds to
    wait before it starts (time to switch windows). Starting a demo cancels any running one."""
    global DEMO_TASK
    if n not in DEMOS:
        return {"ok": False, "error": "demo must be 1, 2, 3 or 4"}
    await _cancel_demo()
    DEMO_TASK = asyncio.create_task(_run_demo(n, delay))
    return {"ok": True, "demo": n, "title": DEMOS[n][0], "starts_in_seconds": delay}


@app.get("/api/belt")
def get_belt():
    """Current belt-inspection state, so a freshly opened dashboard tab can catch up."""
    return belt_state


# --------------------------------------------------------------------------
# WebSocket — the dashboard connects here for live telemetry + alert events
# --------------------------------------------------------------------------
@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_connections.remove(websocket)
