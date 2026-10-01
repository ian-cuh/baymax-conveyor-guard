import React, { useEffect, useMemo, useState, useRef } from "react";
import { AreaChart, Area, XAxis, ResponsiveContainer, Tooltip } from "recharts";
import {
  Home, FileText, BarChart2, Activity, PlayCircle, LogOut, Search,
  Gauge, Thermometer, Waves, RadioTower, AlertTriangle, Bell, ArrowRight,
  CheckCircle2, X, User, Settings, Wifi, ClipboardList, Camera, Download, CalendarDays
} from "lucide-react";

// Base URL for plain HTTP calls to the backend (demo controls, alert fetches).
// If you're opening the dashboard from your PHONE, change "localhost" to
// your Mac's LAN IP here too (same one used for BACKEND_WS_URL below),
// otherwise the phone can't reach your laptop's backend.
const BACKEND_HTTP_URL = "http://localhost:8000";

const JOINT_META = [
  { id: "J1", name: "Joint 1", icon: Waves, color: "#7C6EF2" },
];

// Real alert data now comes from the backend (see useLiveAlerts below) —
// no more hardcoded demo arrays here.

// Backend WebSocket URL. If you open the dashboard from a different device
// than the one running Docker, change "localhost" to that machine's LAN IP.
const BACKEND_WS_URL = "ws://localhost:8000/ws/live";

function timeAgoLabel(isoString, nowMs) {
  if (!isoString) return "";
  const then = new Date(isoString).getTime();
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

const BELT_DEFAULT = {
  demo: null, state: "idle", round: 0, message: "", tear_mm: null,
  first_tear_mm: null, growth_x: null, verify_done: 0, verify_total: 0, finished: false,
};

function useLiveTelemetry() {
  const [series, setSeries] = useState([]);
  const [openAlerts, setOpenAlerts] = useState([]);
  const [resolvedAlerts, setResolvedAlerts] = useState([]);
  const [belt, setBelt] = useState(BELT_DEFAULT);

  const [joints, setJoints] = useState(
    JOINT_META.map((j) => ({
      ...j,
      health: 0,
      lastCheckAt: null,
      status: "Healthy",
      tension: 0,
      temperature: 0,
      speed: 0,
    }))
  );

  // Load whatever alerts already exist on the backend as soon as the
  // dashboard opens, so you're not staring at an empty panel until the
  // next reading arrives.
  useEffect(() => {
    fetch("http://localhost:8000/api/alerts?status=open")
      .then((r) => r.json())
      .then(setOpenAlerts)
      .catch(() => {});
    fetch("http://localhost:8000/api/alerts?status=resolved")
      .then((r) => r.json())
      .then(setResolvedAlerts)
      .catch(() => {});
    fetch("http://localhost:8000/api/belt")
      .then((r) => r.json())
      .then(setBelt)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let ws;
    let reconnectTimer;
    let cancelled = false;

    function connect() {
      ws = new WebSocket(BACKEND_WS_URL);

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return; // ignore malformed messages instead of crashing the UI
        }

        if (msg.type === "telemetry") {
          const reading = msg;
          setJoints((prev) =>
            prev.map((j) => {
              if (j.id !== reading.joint_id) return j;
              const status =
                reading.level === "critical" ? "Critical" :
                reading.level === "warning" ? "Warning" : "Healthy";
              return {
                ...j,
                health: reading.health,
                status,
                tension: reading.tension_kn,
                temperature: reading.temperature_c,
                speed: reading.speed_mps,
                lastCheckAt: Date.now(),
              };
            })
          );

          // Drive the vibration chart off Joint 1's stream (swap the id
          // below if you'd rather chart a different joint).
          if (reading.joint_id === "J1") {
            setSeries((prev) => {
              const next = [...prev, {
                t: prev.length, tIdx: prev.length, vibration: reading.vibration_g,
              }];
              return next.slice(-12);
            });
          }
          return;
        }

        if (msg.type === "alert_opened") {
          setOpenAlerts((prev) => [msg.alert, ...prev.filter((a) => a.id !== msg.alert.id)]);
          return;
        }

        if (msg.type === "alert_resolved") {
          setOpenAlerts((prev) => prev.filter((a) => a.alert_type !== msg.alert.alert_type || a.joint_id !== msg.alert.joint_id));
          setResolvedAlerts((prev) => [msg.alert, ...prev].slice(0, 100));
          return;
        }

        // Belt-round inspection state (rounds, tear verification, stop).
        if (msg.type === "belt_status") {
          const { type, ...state } = msg;
          setBelt(state);
          return;
        }

        // A demo reset / new demo start: wipe everything so takes don't overlap.
        if (msg.type === "demo_reset") {
          setOpenAlerts([]);
          setResolvedAlerts([]);
          setSeries([]);
          setBelt(BELT_DEFAULT);
          return;
        }
      };

      ws.onclose = () => {
        if (!cancelled) reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);

  return { series, joints, openAlerts, resolvedAlerts, belt };
}

function formatAgo(timestampMs, nowMs) {
  if (!timestampMs) return "waiting for data…";
  const seconds = Math.max(0, Math.round((nowMs - timestampMs) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min ago`;
}

const statusColor = {
  Healthy: "#22b07d",
  Warning: "#e2a53a",
  Critical: "#e2513f",
};

const alertColor = {
  ok: "#22b07d",
  warning: "#e2a53a",
  critical: "#e2513f",
};


// Demo historical cycle data for the Reports feature.
// The live backend still powers today's real-time values; this data is intentionally
// synthetic so the prototype can demonstrate historical reporting before a database
// is connected.
const DEMO_HISTORY = [
  {
    date: "2026-09-30",
    label: "Today",
    cycles: [
      { cycle: 1, start: "08:00", duration: 42, health: 98.8, avgTension: 4.12, maxTemp: 47.1, avgVibration: 0.34, alerts: 0 },
      { cycle: 2, start: "09:30", duration: 45, health: 99.1, avgTension: 4.08, maxTemp: 47.8, avgVibration: 0.36, alerts: 0 },
      { cycle: 3, start: "11:00", duration: 44, health: 98.7, avgTension: 4.16, maxTemp: 48.2, avgVibration: 0.39, alerts: 1 },
      { cycle: 4, start: "12:45", duration: 46, health: 99.0, avgTension: 4.11, maxTemp: 48.0, avgVibration: 0.35, alerts: 0 },
      { cycle: 5, start: "14:15", duration: 43, health: 99.2, avgTension: 4.09, maxTemp: 47.5, avgVibration: 0.33, alerts: 0 },
      { cycle: 6, start: "15:00", duration: 41, health: 99.2, avgTension: 4.10, maxTemp: 47.4, avgVibration: 0.32, alerts: 0 },
    ],
  },
  {
    date: "2026-09-29",
    label: "Yesterday",
    cycles: [
      { cycle: 1, start: "08:05", duration: 44, health: 98.2, avgTension: 4.18, maxTemp: 48.4, avgVibration: 0.38, alerts: 0 },
      { cycle: 2, start: "09:40", duration: 47, health: 97.9, avgTension: 4.22, maxTemp: 49.1, avgVibration: 0.41, alerts: 1 },
      { cycle: 3, start: "11:10", duration: 46, health: 98.0, avgTension: 4.19, maxTemp: 49.0, avgVibration: 0.40, alerts: 1 },
      { cycle: 4, start: "12:50", duration: 43, health: 98.4, avgTension: 4.14, maxTemp: 48.3, avgVibration: 0.37, alerts: 0 },
      { cycle: 5, start: "14:20", duration: 45, health: 98.6, avgTension: 4.12, maxTemp: 47.9, avgVibration: 0.36, alerts: 0 },
      { cycle: 6, start: "16:00", duration: 42, health: 98.5, avgTension: 4.15, maxTemp: 48.0, avgVibration: 0.35, alerts: 0 },
    ],
  },
  {
    date: "2026-09-28",
    label: "2 days ago",
    cycles: [
      { cycle: 1, start: "08:00", duration: 43, health: 97.8, avgTension: 4.20, maxTemp: 49.0, avgVibration: 0.42, alerts: 1 },
      { cycle: 2, start: "09:35", duration: 46, health: 97.5, avgTension: 4.23, maxTemp: 49.6, avgVibration: 0.44, alerts: 1 },
      { cycle: 3, start: "11:05", duration: 48, health: 97.3, avgTension: 4.25, maxTemp: 50.1, avgVibration: 0.46, alerts: 2 },
      { cycle: 4, start: "13:00", duration: 45, health: 97.7, avgTension: 4.21, maxTemp: 49.3, avgVibration: 0.43, alerts: 1 },
      { cycle: 5, start: "14:40", duration: 44, health: 97.9, avgTension: 4.18, maxTemp: 48.8, avgVibration: 0.40, alerts: 0 },
      { cycle: 6, start: "16:15", duration: 42, health: 98.0, avgTension: 4.16, maxTemp: 48.4, avgVibration: 0.38, alerts: 0 },
    ],
  },
  {
    date: "2026-09-27",
    label: "3 days ago",
    cycles: [
      { cycle: 1, start: "08:10", duration: 41, health: 98.6, avgTension: 4.10, maxTemp: 47.2, avgVibration: 0.34, alerts: 0 },
      { cycle: 2, start: "09:45", duration: 43, health: 98.8, avgTension: 4.07, maxTemp: 47.6, avgVibration: 0.33, alerts: 0 },
      { cycle: 3, start: "11:20", duration: 42, health: 98.9, avgTension: 4.09, maxTemp: 47.8, avgVibration: 0.35, alerts: 0 },
      { cycle: 4, start: "13:05", duration: 44, health: 98.7, avgTension: 4.11, maxTemp: 48.0, avgVibration: 0.36, alerts: 0 },
      { cycle: 5, start: "14:35", duration: 43, health: 98.9, avgTension: 4.08, maxTemp: 47.4, avgVibration: 0.34, alerts: 0 },
      { cycle: 6, start: "16:10", duration: 40, health: 99.0, avgTension: 4.06, maxTemp: 47.0, avgVibration: 0.32, alerts: 0 },
    ],
  },
];

function historySummary(day) {
  const cycles = day.cycles;
  const avg = (key) => (cycles.reduce((sum, c) => sum + c[key], 0) / cycles.length).toFixed(2);
  return {
    cycles: cycles.length,
    avgHealth: `${avg("health")}%`,
    avgTension: `${avg("avgTension")} kN`,
    avgVibration: `${avg("avgVibration")} g`,
    maxTemp: `${Math.max(...cycles.map((c) => c.maxTemp)).toFixed(1)} °C`,
    alerts: cycles.reduce((sum, c) => sum + c.alerts, 0),
  };
}

function downloadBlob(filename, content, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadCycleCSV(day) {
  const rows = [
    ["Belt Health Historical Report"],
    [`Date,${day.date}`],
    ["Cycle","Start","Duration (min)","Health (%)","Avg Tension (kN)","Max Temperature (°C)","Avg Vibration (g)","Alerts"],
    ...day.cycles.map((c) => [
      c.cycle, c.start, c.duration, c.health, c.avgTension, c.maxTemp, c.avgVibration, c.alerts
    ]),
  ];
  downloadBlob(
    `belt-health-${day.date}.csv`,
    rows.map((row) => row.join(",")).join("\n"),
    "text/csv;charset=utf-8"
  );
}

function downloadFullHistoryCSV() {
  const rows = [
    ["Belt Health Historical Report"],
    ["Generated for Smart Conveyor Guard demo"],
    [],
    ["Date","Day","Cycle","Start","Duration (min)","Health (%)","Avg Tension (kN)","Max Temperature (°C)","Avg Vibration (g)","Alerts"],
  ];
  DEMO_HISTORY.forEach((day) => {
    day.cycles.forEach((c) => rows.push([
      day.date, day.label, c.cycle, c.start, c.duration, c.health,
      c.avgTension, c.maxTemp, c.avgVibration, c.alerts
    ]));
  });
  downloadBlob(
    "smart-conveyor-history-report.csv",
    rows.map((row) => row.join(",")).join("\n"),
    "text/csv;charset=utf-8"
  );
}

export default function ConveyorDashboard() {
  const { series, joints, openAlerts, resolvedAlerts, belt } = useLiveTelemetry();

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const currentVibration = series[series.length - 1]?.vibration ?? 0;

  const [modal, setModal] = useState(null);
  const [alertTab, setAlertTab] = useState("Recent");
  const [query, setQuery] = useState("");
  const [timeRange, setTimeRange] = useState("Monthly");

  // Normalize backend alert shape (joint_id/precaution/ISO time) into what
  // the UI below expects, without losing the extra fields (precaution).
  function normalizeAlert(a) {
    return {
      ...a,
      joint: a.joint || a.joint_id,
      level: a.level === "ok" ? "ok" : a.level, // backend already uses ok/warning/critical
      time: timeAgoLabel(a.time, now),
    };
  }

  const allOpenAlerts = openAlerts.map(normalizeAlert);
  const allResolvedAlerts = resolvedAlerts.map(normalizeAlert);
  const visibleAlerts = alertTab === "Recent" ? allOpenAlerts : allResolvedAlerts;

  const filteredJoints = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return joints;
    return joints.filter(
      (j) => j.id.toLowerCase().includes(q) || j.name.toLowerCase().includes(q)
    );
  }, [joints, query]);

  function openModal(title, content) {
    setModal({ title, content });
  }

  function openJoint(j) {
    openModal(
      j.name,
      <div style={styles.detailGrid}>
        <Metric label="Health" value={`${j.health}%`} />
        <Metric label="Status" value={j.status} />
        <Metric label="Tension" value={`${j.tension} kN`} />
        <Metric label="Temperature" value={`${j.temperature} °C`} />
        <Metric label="Speed" value={`${j.speed} m/s`} />
        <Metric label="Last check" value={formatAgo(j.lastCheckAt, Date.now())} />
      </div>
    );
  }

  function openAlert(a) {
    openModal(
      `${a.joint || a.joint_id} — Alert`,
      <div>
        <div style={{ ...styles.bigStatus, color: alertColor[a.level] }}>
          {a.issue}
        </div>
        <p style={styles.modalText}>Severity: {a.level.toUpperCase()}</p>
        <p style={styles.modalText}>Recorded: {a.time}</p>
        <p style={styles.modalText}>
          <strong>Recommended action: </strong>
          {a.precaution || "No specific precaution recorded for this alert."}
        </p>
      </div>
    );
  }

  function rotateTimeRange() {
    const values = ["Monthly", "Weekly", "Today"];
    const next = values[(values.indexOf(timeRange) + 1) % values.length];
    setTimeRange(next);
  }

  function handleSearchKeyDown(e) {
    if (e.key === "Enter") {
      const first = filteredJoints[0];
      if (first) openJoint(first);
      else openModal("Search", <p style={styles.modalText}>No matching joint was found.</p>);
    }
  }

  return (
    <div style={styles.page}>
      <style>{css}</style>

      <div style={styles.shell}>
        <div style={styles.sidebar}>
          <SideButton
            icon={<Home size={18} />}
            active
            title="Home"
            onClick={() =>
              openModal(
                "Home",
                <p style={styles.modalText}>
                  You are already on the main Belt Health Dashboard.
                </p>
              )
            }
          />
          <SideButton
            icon={<FileText size={18} />}
            title="Reports"
            onClick={() => openModal("Historical Reports", <ReportsPanel />)}
          />
          <SideButton
            icon={<BarChart2 size={18} />}
            title="Analytics"
            onClick={() =>
              openModal(
                "Analytics",
                <div style={styles.detailGrid}>
                  <Metric label="Uptime today" value="99.2%" />
                  <Metric label="Average tension" value="4.1 kN" />
                  <Metric label="Target tension" value="4.5 kN" />
                  <Metric label="Current vibration" value={`${currentVibration} g`} />
                </div>
              )
            }
          />
          <SideButton
            icon={<Camera size={18} />}
            title="Camera"
            onClick={() => openModal("Live Camera Inspection", <CameraPanel />)}
          />
          <SideButton
            icon={<Activity size={18} />}
            title="Diagnostics"
            onClick={() =>
              openModal(
                "Diagnostics",
                <div>
                  {joints.map((j) => (
                    <button key={j.id} style={styles.fullRowButton} onClick={() => openJoint(j)}>
                      <span>{j.name}</span>
                      <strong style={{ color: statusColor[j.status] }}>{j.status}</strong>
                    </button>
                  ))}
                </div>
              )
            }
          />
          <SideButton
            icon={<PlayCircle size={18} />}
            title="Live Monitoring"
            onClick={() =>
              openModal(
                "Live Monitoring",
                <div style={styles.detailGrid}>
                  <Metric label="Feed" value="Streaming" />
                  <Metric label="Vibration" value={`${currentVibration} g`} />
                  <Metric label="Connected joints" value={`${joints.length}`} />
                  <Metric label="Update rate" value="2.2 sec" />
                </div>
              )
            }
          />
          <div style={{ flex: 1 }} />
          <SideButton
            icon={<LogOut size={18} />}
            title="Logout"
            onClick={() =>
              openModal(
                "Logout",
                <div>
                  <p style={styles.modalText}>
                    This prototype has no authentication yet, so there is no real session to close.
                  </p>
                  <button style={styles.primaryButton} onClick={() => setModal(null)}>
                    OK
                  </button>
                </div>
              )
            }
          />
        </div>

        <div style={styles.main}>
          <div style={styles.headerRow}>
            <div>
              <div style={styles.eyebrow}>Smart Conveyor Guard</div>
              <div style={styles.title}>Belt Health Dashboard</div>
            </div>

            <div style={styles.headerRight}>
              <div style={styles.searchBox}>
                <Search size={15} color="#a6a6c8" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search joint / segment"
                  style={styles.searchInput}
                />
              </div>

              <button
                style={styles.avatarButton}
                onClick={() =>
                  openModal(
                    "Operator Profile",
                    <div style={styles.detailGrid}>
                      <Metric label="Role" value="SC Operator" />
                      <Metric label="Dashboard" value="Conveyor Guard" />
                    </div>
                  )
                }
              >
                SC
              </button>
            </div>
          </div>

          <BeltInspectionCard belt={belt} />

          <div style={styles.row}>
            <div style={styles.overviewCard}>
              <div style={styles.overviewTop}>
                <div style={{ fontSize: 13, opacity: 0.85 }}>Overview — Live Feed</div>
                <button style={styles.pillButton} onClick={rotateTimeRange}>
                  {timeRange} ▾
                </button>
              </div>

              <div style={{ height: 150, marginTop: 6, position: "relative" }}>
                <div
                  style={styles.chartTag}
                  onClick={() =>
                    openModal(
                      "Current Vibration",
                      <p style={styles.bigStatus}>{currentVibration} g</p>
                    )
                  }
                >
                  {currentVibration} g
                  <div style={{ fontSize: 10, fontWeight: 400 }}>Vibration</div>
                </div>

                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={series}>
                    <defs>
                      <linearGradient id="vib" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#ffffff" stopOpacity={0.9} />
                        <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="t" hide />
                    <Tooltip
                      contentStyle={{
                        background: "#4d3fc9",
                        border: "none",
                        borderRadius: 8,
                        fontSize: 11,
                        color: "#fff",
                      }}
                      labelFormatter={() => ""}
                      formatter={(v) => [`${v} g`, "Vibration"]}
                    />
                    <Area
                      type="monotone"
                      dataKey="vibration"
                      stroke="#ffffff"
                      strokeWidth={2.5}
                      fill="url(#vib)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div style={styles.checkpointRow}>
                {["J1"].map((j) => (
                  <button
                    key={j}
                    style={styles.checkpointButton}
                    onClick={() => {
                      const found = joints.find((x) => x.id === j);
                      if (found) openJoint(found);
                      else
                        openModal(
                          j,
                          <p style={styles.modalText}>
                            {j} is shown on the line map, but detailed prototype data has not been
                            added for this joint yet.
                          </p>
                        );
                    }}
                  >
                    {j}
                  </button>
                ))}
              </div>

              <div style={styles.statRow}>
                <StatButton
                  value="99.2%"
                  label="Uptime · Today"
                  onClick={() =>
                    openModal("Uptime", <p style={styles.bigStatus}>99.2%</p>)
                  }
                />
                <StatButton
                  value="4.1 kN"
                  label="Avg Tension"
                  onClick={() =>
                    openModal("Average Tension", <p style={styles.bigStatus}>4.1 kN</p>)
                  }
                />
                <StatButton
                  value="4.5 kN"
                  label="Target"
                  onClick={() =>
                    openModal("Target Tension", <p style={styles.bigStatus}>4.5 kN</p>)
                  }
                />
              </div>
            </div>

            <div style={styles.actionCol}>
              <button
                style={{
                  ...styles.actionCardButton,
                  background: "linear-gradient(135deg,#8f7cf2,#6c5ce7)",
                }}
                onClick={() =>
                  openModal(
                    "Live Monitoring",
                    <div style={styles.detailGrid}>
                      {joints.map((j) => (
                        <Metric key={j.id} label={j.id} value={`${j.health}% · ${j.status}`} />
                      ))}
                    </div>
                  )
                }
              >
                <div style={styles.actionIconWrap}>
                  <RadioTower size={18} color="#6c5ce7" />
                </div>
                <div style={styles.actionTitle}>Live Monitoring</div>
                <div style={styles.actionSub}>{joints.some((j) => j.lastCheckAt) ? "Joint streaming live" : "Waiting for data"}</div>
              </button>

              <button
                style={{
                  ...styles.actionCardButton,
                  background: "linear-gradient(135deg,#f28ec0,#ec6fae)",
                }}
                onClick={() =>
                  openModal(
                    "Predictive Alerts",
                    <div>
                      {allOpenAlerts.filter((a) => a.level !== "ok").length === 0 ? (
                        <p style={styles.modalText}>No active alerts right now — all monitored values are within normal range.</p>
                      ) : (
                        allOpenAlerts.filter((a) => a.level !== "ok").map((a) => (
                          <button
                            key={a.id}
                            style={styles.fullRowButton}
                            onClick={() => openAlert(a)}
                          >
                            <span>{a.joint}</span>
                            <strong>{a.issue}</strong>
                          </button>
                        ))
                      )}
                    </div>
                  )
                }
              >
                <div style={styles.actionIconWrap}>
                  <AlertTriangle size={18} color="#ec6fae" />
                </div>
                <div style={styles.actionTitle}>Predictive Alerts</div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "space-between",
                    marginTop: 10,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 26, fontWeight: 700, color: "#fff" }}>{allOpenAlerts.length}</div>
                    <div style={styles.actionSub}>Active · This week</div>
                  </div>
                  <div style={styles.arrowBtn}>
                    <ArrowRight size={14} color="#ec6fae" />
                  </div>
                </div>
              </button>
            </div>
          </div>

          <div style={styles.jointRow}>
            {filteredJoints.length === 0 ? (
              <div style={styles.noResults}>No joints match “{query}”.</div>
            ) : (
              filteredJoints.map((j) => {
                const Icon = j.icon;
                return (
                  <button key={j.id} style={styles.jointCardButton} onClick={() => openJoint(j)}>
                    <div style={styles.jointTop}>
                      <div style={{ ...styles.jointIconWrap, background: j.color }}>
                        <Icon size={16} color="#fff" />
                      </div>
                      <span
                        style={{
                          ...styles.statusPill,
                          background: statusColor[j.status] + "22",
                          color: statusColor[j.status],
                        }}
                      >
                        {j.status}
                      </span>
                    </div>
                    <div style={styles.jointName}>{j.name}</div>
                    <div style={styles.jointSub}>Last check {formatAgo(j.lastCheckAt, now)}</div>
                    <div style={styles.progressTrack}>
                      <div
                        style={{
                          ...styles.progressFill,
                          width: `${j.health}%`,
                          background: statusColor[j.status],
                        }}
                      />
                    </div>
                    <div style={styles.jointFooter}>
                      <span>{j.health}% health</span>
                      <span style={styles.jointPill}>ID {j.id}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <button
            style={styles.historyCard}
            onClick={() => openModal("Historical Reports", <ReportsPanel />)}
          >
            <div style={styles.historyIcon}>
              <CalendarDays size={18} color="#6c5ce7" />
            </div>
            <div style={{ flex: 1, textAlign: "left" }}>
              <div style={styles.historyTitle}>Historical Reports</div>
              <div style={styles.historySub}>
                View today + previous 3 days, cycle-by-cycle performance and download the data.
              </div>
            </div>
            <div style={styles.historyDownload}>
              <Download size={15} />
              Export
            </div>
          </button>
        </div>

        <div style={styles.rightPanel}>
          <div style={styles.panelHeadRow}>
            <div style={styles.panelHead}>
              <Bell size={15} style={{ marginRight: 6 }} />
              Alerts
            </div>
            <button
              style={styles.textButton}
              onClick={() =>
                openModal(
                  "All Alerts",
                  <div>
                    {[...allOpenAlerts, ...allResolvedAlerts].map((a) => (
                      <button key={a.id} style={styles.fullRowButton} onClick={() => openAlert(a)}>
                        <span>{a.joint}</span>
                        <strong>{a.issue}</strong>
                      </button>
                    ))}
                  </div>
                )
              }
            >
              View All
            </button>
          </div>

          <div style={styles.tabsRow}>
            {["Recent", "Resolved"].map((tab) => (
              <button
                key={tab}
                style={{
                  ...styles.tabButton,
                  ...(alertTab === tab ? styles.tabActive : {}),
                }}
                onClick={() => setAlertTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          <div style={styles.alertList}>
            {visibleAlerts.length === 0 ? (
              <div style={{ padding: "20px 10px", textAlign: "center", color: "var(--text-secondary, #888)" }}>
                {alertTab === "Recent"
                  ? "No active alerts — readings are within normal range."
                  : "No resolved alerts yet."}
              </div>
            ) : (
              visibleAlerts.map((a) => (
              <button key={a.id} style={styles.alertItemButton} onClick={() => openAlert(a)}>
                <div style={{ ...styles.alertDot, background: alertColor[a.level] }}>
                  {a.level === "ok" ? (
                    <CheckCircle2 size={14} color="#fff" />
                  ) : (
                    <AlertTriangle size={14} color="#fff" />
                  )}
                </div>
                <div style={{ flex: 1, textAlign: "left" }}>
                  <div style={styles.alertJoint}>{a.joint}</div>
                  <div style={styles.alertIssue}>{a.issue}</div>
                </div>
                <div style={styles.alertTime}>{a.time}</div>
              </button>
              ))
            )}
          </div>

          <div style={styles.panelHeadRow}>
            <div style={styles.panelHead}>Line Status</div>
            <button
              style={styles.textButton}
              onClick={() =>
                openModal(
                  "Line Status",
                  <div style={styles.detailGrid}>
                    <Metric label="Healthy" value={`${joints.filter((j) => j.status === "Healthy").length} joint(s)`} />
                    <Metric label="Warning" value={`${joints.filter((j) => j.status === "Warning").length} joint(s)`} />
                    <Metric label="Critical" value={`${joints.filter((j) => j.status === "Critical").length} joint(s)`} />
                    <Metric label="Feed" value={joints.some((j) => j.lastCheckAt) ? "Online" : "Waiting for data"} />
                  </div>
                )
              }
            >
              View
            </button>
          </div>

          <div style={styles.lineMap}>
            <svg viewBox="0 0 220 90" width="100%" height="90">
              <line
                x1="10"
                y1="45"
                x2="210"
                y2="45"
                stroke="#e3e1f5"
                strokeWidth="6"
                strokeLinecap="round"
              />
              {joints.map((j, i, arr) => (
                <circle
                  key={j.id}
                  cx={arr.length === 1 ? 110 : 20 + i * (190 / (arr.length - 1))}
                  cy={45}
                  r={7}
                  fill={statusColor[j.status] || statusColor.Healthy}
                  stroke="#fff"
                  strokeWidth={2}
                  style={{ cursor: "pointer" }}
                  onClick={() => openJoint(j)}
                />
              ))}
            </svg>
          </div>

          <button
            style={styles.toolsButton}
            onClick={() =>
              openModal(
                "System Tools",
                <div style={styles.toolGrid}>
                  <Tool icon={<Wifi size={18} />} label="Connection" />
                  <Tool icon={<ClipboardList size={18} />} label="Maintenance" />
                  <Tool icon={<Settings size={18} />} label="Settings" />
                  <Tool icon={<User size={18} />} label="Operator" />
                </div>
              )
            }
          >
            System Tools
          </button>
        </div>
      </div>

      {modal && (
        <div style={styles.modalBackdrop} onMouseDown={() => setModal(null)}>
          <div style={styles.modalCard} onMouseDown={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={styles.modalTitle}>{modal.title}</div>
              <button style={styles.closeButton} onClick={() => setModal(null)}>
                <X size={18} />
              </button>
            </div>
            <div>{modal.content}</div>
          </div>
        </div>
      )}
    </div>
  );
}


function ReportsPanel() {
  const [selectedDate, setSelectedDate] = useState(DEMO_HISTORY[0].date);
  const selected = DEMO_HISTORY.find((d) => d.date === selectedDate) || DEMO_HISTORY[0];
  const summary = historySummary(selected);

  return (
    <div>
      <div style={styles.reportIntro}>
        <div>
          <div style={styles.reportEyebrow}>HISTORICAL DATA</div>
          <div style={styles.reportHeading}>Cycle performance history</div>
          <p style={styles.modalText}>
            Demo historical data is included for the previous 3 days and today.
            Today's live readings can be connected to persistent storage later.
          </p>
        </div>
        <button style={styles.primaryButton} onClick={downloadFullHistoryCSV}>
          <Download size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />
          Download All
        </button>
      </div>

      <div style={styles.reportDayTabs}>
        {DEMO_HISTORY.map((day) => (
          <button
            key={day.date}
            style={{
              ...styles.reportDayButton,
              ...(selectedDate === day.date ? styles.reportDayActive : {}),
            }}
            onClick={() => setSelectedDate(day.date)}
          >
            <strong>{day.label}</strong>
            <span>{day.date}</span>
          </button>
        ))}
      </div>

      <div style={styles.detailGrid}>
        <Metric label="Cycles" value={summary.cycles} />
        <Metric label="Avg health" value={summary.avgHealth} />
        <Metric label="Avg tension" value={summary.avgTension} />
        <Metric label="Avg vibration" value={summary.avgVibration} />
        <Metric label="Peak temperature" value={summary.maxTemp} />
        <Metric label="Alerts" value={summary.alerts} />
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={styles.reportTableHeader}>
          <span>Cycle</span>
          <span>Start</span>
          <span>Health</span>
          <span>Tension</span>
          <span>Vibration</span>
          <span>Alerts</span>
        </div>

        {selected.cycles.map((c) => (
          <div key={c.cycle} style={styles.reportTableRow}>
            <strong>#{c.cycle}</strong>
            <span>{c.start}</span>
            <span>{c.health}%</span>
            <span>{c.avgTension} kN</span>
            <span>{c.avgVibration} g</span>
            <span style={{ color: c.alerts ? "#e2a53a" : "#22b07d", fontWeight: 700 }}>
              {c.alerts}
            </span>
          </div>
        ))}
      </div>

      <div style={styles.reportFooter}>
        <span>Detailed CSV for {selected.date}</span>
        <button style={styles.secondaryButton} onClick={() => downloadCycleCSV(selected)}>
          <Download size={14} /> Download Day Report
        </button>
      </div>
    </div>
  );
}

// Alert types that mean "tear confirmed / belt stopped" — these light up the camera overlay.
const TEAR_STOP_TYPES = ["visual_tear_detected", "tear_confirmed", "tear_growth_stop"];

// Shows what the belt is doing round by round: running / verifying a suspected tear /
// warning / STOPPED, plus verification progress or tear-size growth. Driven by the
// backend's `belt_status` WebSocket events (the scripted demos + future real detection).
function BeltInspectionCard({ belt }) {
  if (!belt || belt.state === "idle") return null;

  const theme = {
    running:   { color: "#22b07d", bg: "#eaf8f2", label: "BELT RUNNING" },
    warning:   { color: "#e2a53a", bg: "#fff6e3", label: "WARNING" },
    verifying: { color: "#e2a53a", bg: "#fff6e3", label: "VERIFYING TEAR" },
    stopped:   { color: "#e2513f", bg: "#e2513f", label: "BELT STOPPED" },
  }[belt.state] || { color: "#22b07d", bg: "#eaf8f2", label: "BELT RUNNING" };

  const stopped = belt.state === "stopped";
  const fg = stopped ? "#fff" : "#2b2a45";
  const showDots = belt.state === "verifying" && belt.verify_total > 0;
  const showTear = belt.tear_mm != null;
  const showGrowth = belt.growth_x != null && belt.growth_x > 1;

  return (
    <div
      style={{
        background: theme.bg,
        border: `2px solid ${theme.color}`,
        borderRadius: 16,
        padding: "12px 16px",
        marginBottom: 14,
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        color: fg,
        animation: stopped ? "beltStopPulse 1s ease-in-out infinite" : undefined,
      }}
    >
      <style>{`
        @keyframes beltStopPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(226,81,63,0.55); }
          50% { box-shadow: 0 0 0 10px rgba(226,81,63,0); }
        }
        @keyframes beltDotPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
      `}</style>

      <div
        style={{
          background: stopped ? "#fff" : theme.color,
          color: stopped ? theme.color : "#fff",
          fontWeight: 800,
          fontSize: 12,
          letterSpacing: 0.6,
          padding: "6px 12px",
          borderRadius: 999,
          display: "flex",
          alignItems: "center",
          gap: 6,
          whiteSpace: "nowrap",
        }}
      >
        {belt.state === "running" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
        {theme.label}
      </div>

      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          {stopped ? "Check Joint 1 for a tear before restarting" : belt.message}
        </div>
        {stopped && <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>{belt.message}</div>}
      </div>

      {showDots && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {Array.from({ length: belt.verify_total }).map((_, i) => (
            <span
              key={i}
              style={{
                width: 12, height: 12, borderRadius: "50%",
                background: i < belt.verify_done ? theme.color : "transparent",
                border: `2px solid ${theme.color}`,
                animation: i === belt.verify_done ? "beltDotPulse 1s ease-in-out infinite" : undefined,
              }}
            />
          ))}
          <span style={{ fontSize: 12, fontWeight: 700 }}>
            {belt.verify_done}/{belt.verify_total} checks
          </span>
        </div>
      )}

      {showTear && (
        <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
          {showGrowth
            ? `Tear ${belt.first_tear_mm} mm → ${belt.tear_mm} mm (×${belt.growth_x})`
            : `Tear ${belt.tear_mm} mm`}
        </div>
      )}

      <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.85, whiteSpace: "nowrap" }}>
        Round {belt.round}
      </div>
    </div>
  );
}

function CameraPanel() {
  const videoRef = useRef(null);
  const [cameraError, setCameraError] = useState(null);
  const [liveAlerts, setLiveAlerts] = useState([]); // open alerts for J1, live
  const [tearDetected, setTearDetected] = useState(false);

  // Start the camera stream
  useEffect(() => {
    let stream;
    let cancelled = false;

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" }, // rear camera on phones
          audio: false,
        });
        if (cancelled) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (err) {
        setCameraError(
          "Couldn't access camera. Make sure you allowed camera permission " +
          "and that the page is opened over https:// or localhost."
        );
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Load whatever alerts already exist, then stay live via WebSocket —
  // same event stream the main dashboard uses.
  useEffect(() => {
    fetch(`${BACKEND_HTTP_URL}/api/alerts?status=open`)
      .then((r) => r.json())
      .then((alerts) => {
        setLiveAlerts(alerts);
        setTearDetected(alerts.some((a) => TEAR_STOP_TYPES.includes(a.alert_type)));
      })
      .catch(() => {});

    let ws;
    let reconnectTimer;
    let cancelled = false;

    function connect() {
      ws = new WebSocket(BACKEND_WS_URL);

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === "alert_opened") {
          setLiveAlerts((prev) => [msg.alert, ...prev.filter((a) => a.id !== msg.alert.id)]);
          if (TEAR_STOP_TYPES.includes(msg.alert.alert_type)) setTearDetected(true);
        }

        if (msg.type === "demo_reset") {
          setLiveAlerts([]);
          setTearDetected(false);
        }

        if (msg.type === "alert_resolved") {
          setLiveAlerts((prev) =>
            prev.filter((a) => !(a.alert_type === msg.alert.alert_type && a.joint_id === msg.alert.joint_id))
          );
          if (TEAR_STOP_TYPES.includes(msg.alert.alert_type)) setTearDetected(false);
        }
      };

      ws.onclose = () => {
        if (!cancelled) reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);

  const levelColor = { critical: "#e2513f", warning: "#e2a53a", ok: "#22b07d" };

  return (
    <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#000" }}>
      {cameraError ? (
        <div style={{ padding: 24, color: "#e2513f", fontSize: 13 }}>{cameraError}</div>
      ) : (
        <video ref={videoRef} style={{ width: "100%", display: "block" }} muted playsInline />
      )}

      {/* Live alert chips, overlaid transparently on top of the feed */}
      {!tearDetected && liveAlerts.length > 0 && (
        <div style={{
          position: "absolute", top: 10, left: 10, right: 10,
          display: "flex", flexDirection: "column", gap: 6, pointerEvents: "none",
        }}>
          {liveAlerts.map((a) => (
            <div
              key={a.id}
              style={{
                background: "rgba(0,0,0,0.55)",
                borderLeft: `4px solid ${levelColor[a.level] || levelColor.warning}`,
                color: "#fff",
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 13,
                backdropFilter: "blur(2px)",
              }}
            >
              <strong>{a.joint || a.joint_id}</strong> — {a.issue}
            </div>
          ))}
        </div>
      )}

      {/* Big red full-screen overlay when a tear is detected */}
      {tearDetected && (
        <div style={{
          position: "absolute", inset: 0,
          background: "rgba(226, 81, 63, 0.55)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column", gap: 8,
          animation: "pulseTear 1s ease-in-out infinite",
        }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,0.6)", textAlign: "center" }}>
            TEAR DETECTED
          </div>
          <div style={{ fontSize: 13, color: "#fff", opacity: 0.9, textAlign: "center", padding: "0 20px" }}>
            Stop the belt immediately — physical damage confirmed at this joint.
          </div>
          <style>{`
            @keyframes pulseTear {
              0%, 100% { background: rgba(226, 81, 63, 0.55); }
              50% { background: rgba(226, 81, 63, 0.8); }
            }
          `}</style>
        </div>
      )}
    </div>
  );
}

function SideButton({ icon, title, active = false, onClick }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        ...styles.sideButton,
        ...(active ? styles.sideIconActive : {}),
      }}
    >
      {icon}
    </button>
  );
}

function StatButton({ value, label, onClick }) {
  return (
    <button style={styles.statButton} onClick={onClick}>
      <div style={styles.statVal}>{value}</div>
      <div style={styles.statLbl}>{label}</div>
    </button>
  );
}

function Metric({ label, value }) {
  return (
    <div style={styles.metricCard}>
      <div style={styles.metricLabel}>{label}</div>
      <div style={styles.metricValue}>{value}</div>
    </div>
  );
}

function Tool({ icon, label }) {
  return (
    <div style={styles.toolItem}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#eef0f8",
    display: "flex",
    justifyContent: "center",
    padding: 24,
    boxSizing: "border-box",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  shell: {
    display: "flex",
    gap: 24,
    width: "100%",
    maxWidth: "100%",
    minHeight: "calc(100vh - 48px)",
    background: "#f6f7fc",
    borderRadius: 28,
    padding: 28,
    boxShadow: "0 30px 60px -20px rgba(60,50,140,0.25)",
  },
  sidebar: {
    width: 72,
    background: "linear-gradient(180deg,#8f7cf2,#6c5ce7)",
    borderRadius: 24,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "24px 0",
    gap: 20,
  },
  sideButton: {
    width: 46,
    height: 46,
    borderRadius: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#e6e2fb",
    cursor: "pointer",
    border: "none",
    background: "transparent",
  },
  sideIconActive: { background: "rgba(255,255,255,0.22)", color: "#fff" },

  main: { flex: 1, minWidth: 0 },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  eyebrow: {
    fontSize: 14,
    color: "#9a97c2",
    fontWeight: 600,
    letterSpacing: 0.5,
  },
  title: { fontSize: 26, fontWeight: 700, color: "#2c2a4a" },
  headerRight: { display: "flex", alignItems: "center", gap: 12 },
  searchBox: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "#fff",
    borderRadius: 12,
    padding: "8px 14px",
    boxShadow: "0 2px 8px rgba(80,70,160,0.06)",
  },
  searchInput: {
    border: "none",
    outline: "none",
    background: "transparent",
    color: "#2c2a4a",
    width: 155,
    fontSize: 13,
  },
  avatarButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    background: "#6c5ce7",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 700,
    border: "none",
    cursor: "pointer",
  },

  row: { display: "flex", gap: 16 },
  overviewCard: {
    flex: 1.6,
    background: "linear-gradient(135deg,#8f7cf2,#5d4fd6)",
    borderRadius: 22,
    padding: "18px 20px",
    color: "#fff",
  },
  overviewTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  pillButton: {
    background: "rgba(255,255,255,0.18)",
    color: "#fff",
    fontSize: 11,
    padding: "5px 10px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
  },
  chartTag: {
    position: "absolute",
    top: 0,
    left: "38%",
    background: "#fff",
    color: "#4d3fc9",
    fontSize: 12,
    fontWeight: 700,
    padding: "4px 10px",
    borderRadius: 10,
    zIndex: 2,
    textAlign: "center",
    boxShadow: "0 6px 14px rgba(0,0,0,0.15)",
    cursor: "pointer",
  },
  checkpointRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 10,
    opacity: 0.9,
    padding: "0 4px",
  },
  checkpointButton: {
    border: "none",
    background: "transparent",
    color: "#fff",
    fontSize: 10,
    cursor: "pointer",
    padding: 2,
  },
  statRow: {
    display: "flex",
    justifyContent: "space-between",
    background: "rgba(255,255,255,0.12)",
    borderRadius: 14,
    padding: "8px 10px",
    marginTop: 14,
    gap: 8,
  },
  statButton: {
    flex: 1,
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    padding: "4px 6px",
    borderRadius: 8,
  },
  statVal: { fontSize: 24, fontWeight: 700 },
  statLbl: { fontSize: 13, opacity: 0.8, marginTop: 4 },

  actionCol: { flex: 1, display: "flex", flexDirection: "column", gap: 16 },
  actionCardButton: {
    flex: 1,
    borderRadius: 20,
    padding: 16,
    color: "#fff",
    position: "relative",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
  },
  actionIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    background: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 22,
  },
  actionTitle: { fontSize: 16, fontWeight: 700 },
  actionSub: { fontSize: 12, opacity: 0.85, marginTop: 4 },
  arrowBtn: {
    width: 26,
    height: 26,
    borderRadius: 8,
    background: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  jointRow: { display: "flex", gap: 16, marginTop: 16 },
  jointCardButton: {
    flex: 1,
    background: "#fff",
    borderRadius: 18,
    padding: 16,
    boxShadow: "0 4px 16px rgba(80,70,160,0.06)",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    minWidth: 0,
  },
  jointTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  jointIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  statusPill: { fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 8 },
  jointName: { fontSize: 18, fontWeight: 700, color: "#2c2a4a", marginTop: 16 },
  jointSub: { fontSize: 13, color: "#9a97c2", marginTop: 4, marginBottom: 12 },
  progressTrack: { height: 8, background: "#eef0f8", borderRadius: 8, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 8, transition: "width 0.6s ease" },
  jointFooter: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 12,
    color: "#9a97c2",
    marginTop: 12,
  },
  jointPill: {
    background: "#f2f1fb",
    padding: "2px 7px",
    borderRadius: 6,
    color: "#6c5ce7",
    fontWeight: 700,
  },
  noResults: {
    flex: 1,
    background: "#fff",
    borderRadius: 18,
    padding: 20,
    color: "#9a97c2",
  },

  rightPanel: { width: 340, display: "flex", flexDirection: "column", gap: 16 },
  panelHeadRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 12,
    marginBottom: 4,
  },
  panelHead: {
    display: "flex",
    alignItems: "center",
    fontSize: 13,
    fontWeight: 700,
    color: "#2c2a4a",
  },
  textButton: {
    fontSize: 10,
    color: "#6c5ce7",
    fontWeight: 600,
    border: "none",
    background: "transparent",
    cursor: "pointer",
  },
  tabsRow: { display: "flex", gap: 8, marginBottom: 4 },
  tabButton: {
    fontSize: 10,
    padding: "5px 10px",
    borderRadius: 8,
    color: "#9a97c2",
    background: "#fff",
    border: "none",
    cursor: "pointer",
  },
  tabActive: { background: "#6c5ce7", color: "#fff" },
  alertList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    background: "#fff",
    borderRadius: 16,
    padding: 8,
  },
  alertItemButton: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    padding: "4px",
    borderRadius: 8,
  },
  alertDot: {
    width: 26,
    height: 26,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  alertJoint: { fontSize: 13, fontWeight: 700, color: "#2c2a4a" },
  alertIssue: { fontSize: 12, color: "#9a97c2" },
  alertTime: { fontSize: 11, color: "#bdbbd8", whiteSpace: "nowrap" },
  lineMap: { background: "#fff", borderRadius: 16, padding: "14px 10px" },
  toolsButton: {
    marginTop: 8,
    border: "none",
    borderRadius: 14,
    background: "#fff",
    padding: "12px 16px",
    color: "#6c5ce7",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },

  historyCard: {
    marginTop: 16,
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 12,
    border: "none",
    background: "#fff",
    borderRadius: 18,
    padding: "13px 14px",
    boxShadow: "0 4px 16px rgba(80,70,160,0.06)",
    cursor: "pointer",
  },
  historyIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    background: "#f2f1fb",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  historyTitle: { fontSize: 12, fontWeight: 800, color: "#2c2a4a" },
  historySub: { fontSize: 10, color: "#9a97c2", marginTop: 2, lineHeight: 1.4 },
  historyDownload: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: "#f2f1fb",
    color: "#6c5ce7",
    padding: "7px 9px",
    borderRadius: 9,
    fontSize: 10,
    fontWeight: 700,
    flexShrink: 0,
  },
  reportIntro: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 16,
  },
  reportEyebrow: { fontSize: 9, letterSpacing: 1, fontWeight: 800, color: "#9a97c2" },
  reportHeading: { fontSize: 18, fontWeight: 800, color: "#2c2a4a", margin: "3px 0 5px" },
  reportDayTabs: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 7,
    marginBottom: 14,
  },
  reportDayButton: {
    border: "none",
    background: "#f6f7fc",
    color: "#6d6a8f",
    borderRadius: 10,
    padding: "8px 6px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: 2,
    textAlign: "left",
  },
  reportDayActive: { background: "#6c5ce7", color: "#fff" },
  reportTableHeader: {
    display: "grid",
    gridTemplateColumns: "0.7fr 0.8fr 1fr 1fr 1fr 0.7fr",
    gap: 6,
    padding: "8px 10px",
    background: "#f2f1fb",
    borderRadius: "10px 10px 0 0",
    fontSize: 9,
    color: "#8581a5",
    fontWeight: 700,
  },
  reportTableRow: {
    display: "grid",
    gridTemplateColumns: "0.7fr 0.8fr 1fr 1fr 1fr 0.7fr",
    gap: 6,
    padding: "9px 10px",
    borderBottom: "1px solid #eeeef6",
    fontSize: 10,
    color: "#5e5a7d",
    alignItems: "center",
  },
  reportFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginTop: 14,
    paddingTop: 12,
    borderTop: "1px solid #eeeef6",
    color: "#9a97c2",
    fontSize: 10,
  },
  secondaryButton: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    border: "none",
    borderRadius: 9,
    background: "#f2f1fb",
    color: "#6c5ce7",
    padding: "8px 10px",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 10,
  },

  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(25, 22, 50, 0.34)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 9999,
  },
  modalCard: {
    width: "min(560px, 94vw)",
    maxHeight: "80vh",
    overflowY: "auto",
    background: "#fff",
    borderRadius: 22,
    padding: 20,
    boxShadow: "0 24px 70px rgba(30,25,80,0.3)",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: { fontSize: 18, fontWeight: 800, color: "#2c2a4a" },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 10,
    border: "none",
    background: "#f2f1fb",
    color: "#6c5ce7",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  modalText: { color: "#6d6a8f", fontSize: 13, lineHeight: 1.6 },
  bigStatus: { fontSize: 28, fontWeight: 800, color: "#2c2a4a", margin: "8px 0" },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 12,
  },
  metricCard: {
    background: "#f6f7fc",
    borderRadius: 14,
    padding: 14,
  },
  metricLabel: { fontSize: 10, color: "#9a97c2", marginBottom: 5 },
  metricValue: { fontSize: 15, fontWeight: 800, color: "#2c2a4a" },
  fullRowButton: {
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    gap: 14,
    border: "none",
    background: "#f6f7fc",
    padding: "11px 12px",
    borderRadius: 12,
    marginBottom: 8,
    cursor: "pointer",
    color: "#2c2a4a",
    textAlign: "left",
  },
  simpleRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 0",
    borderBottom: "1px solid #eeeef6",
    color: "#565276",
    fontSize: 12,
  },
  primaryButton: {
    border: "none",
    borderRadius: 10,
    background: "#6c5ce7",
    color: "#fff",
    padding: "9px 14px",
    cursor: "pointer",
  },
  toolGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
  },
  toolItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#f6f7fc",
    borderRadius: 12,
    padding: 12,
    color: "#565276",
    fontSize: 12,
  },
};

const css = `
  * { box-sizing: border-box; }
  button { font: inherit; }
  button:hover { filter: brightness(0.985); }
  button:active { transform: translateY(1px); }
  @media (max-width: 980px) {
    body { margin: 0; }
  }
`;

