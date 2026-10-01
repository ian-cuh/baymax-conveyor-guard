"""
Fake ESP32 sensor node. Publishes MQTT messages matching the data contract
in backend/main.py, so you can test/demo the whole pipeline with no hardware.

Run this on your Mac (NOT inside Docker) after `docker compose up` is running:
    pip3 install paho-mqtt --break-system-packages
    python3 simulator.py
    python3 simulator.py --scenario joint_failure
"""
import json
import time
import random
import argparse
from datetime import datetime, timezone
import paho.mqtt.client as mqtt

JOINTS = ["J1"]  # single joint only — matches the real hardware setup


def normal_reading():
    return {
        "vibration_g": round(random.gauss(0.3, 0.05), 2),
        "tension_kn": round(random.gauss(4.5, 0.2), 2),
        "speed_mps": round(random.gauss(1.2, 0.05), 2),
    }


def failure_progress_reading(t, duration):
    progress = min(t / duration, 1.0)
    return {
        "vibration_g": round(random.gauss(0.3 + 1.0 * progress, 0.05), 2),
        "tension_kn": round(random.gauss(4.5 - 2.0 * progress, 0.2), 2),
        "speed_mps": round(random.gauss(1.2 - 0.2 * progress, 0.05), 2),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=["normal", "joint_failure"], default="normal")
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--duration", type=float, default=60.0)
    args = parser.parse_args()

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.connect(args.host, args.port, keepalive=30)
    client.loop_start()

    print(f"Simulator started. Scenario={args.scenario}. Ctrl+C to stop.")
    failing_joint = "J1"
    t0 = time.time()

    try:
        while True:
            t = time.time() - t0
            for joint_id in JOINTS:
                if args.scenario == "joint_failure" and joint_id == failing_joint:
                    reading = failure_progress_reading(t, args.duration)
                else:
                    reading = normal_reading()

                payload = {
                    "joint_id": joint_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    **reading,
                }
                topic = f"conveyor/{joint_id}/telemetry"
                client.publish(topic, json.dumps(payload))
                print(f"Published {joint_id}: {reading}")

            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
