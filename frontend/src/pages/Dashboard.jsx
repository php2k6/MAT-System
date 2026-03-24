import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid
} from "recharts";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const WS_BASE_URL  = import.meta.env.VITE_WS_BASE_URL
  || API_BASE_URL.replace(/^http/, "ws"); // http->ws, https->wss

const CHART_RANGES = ["1W", "1M", "3M", "1Y", "3Y", "5Y", "10Y", "MAX"];

const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

// ─── API SERVICE LAYER ────────────────────────────────────────────────────────
const api = {
  getPortfolio: async () => {
    const res = await fetch(`${API_BASE_URL}/portfolio`, {
      method: "GET",
      credentials: "include",
    });
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    if (!res.ok) throw new Error(`Portfolio fetch failed: ${res.status}`);
    return res.json();
  },

  getChartData: async (range = "1M") => {
    const res = await fetch(
      `${API_BASE_URL}/portfolio/chart?range=${encodeURIComponent(range)}`,
      { method: "GET", credentials: "include" }
    );
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    if (res.status === 400) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.detail?.message || "Invalid range");
    }
    if (!res.ok) throw new Error(`Chart fetch failed: ${res.status}`);
    return res.json();
  },

  postAction: async (action) => {
    const res = await fetch(`${API_BASE_URL}/strategy/action`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    if (!res.ok) throw new Error(`Action failed: ${res.status}`);
    return res.json();
  },
};

// ─── WEBSOCKET HOOK ───────────────────────────────────────────────────────────
function useLiveWebSocket({ enabled, onHoldingsUpdate, onSummaryUpdate, onUnauthorized }) {
  const wsRef          = useRef(null);
  const reconnectTimer = useRef(null);
  const unmounted      = useRef(false);
  const reconnectCount = useRef(0);  // ✅ ADD THIS
  const MAX_RECONNECTS = 5;          // ✅ ADD THIS
  const [wsStatus, setWsStatus] = useState("disconnected");

  const connect = useCallback(() => {
    if (!enabled || unmounted.current) return;
    if (wsRef.current && wsRef.current.readyState < 2) return;

    setWsStatus("connecting");
    const ws = new WebSocket(`${WS_BASE_URL}/live/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!unmounted.current) {
        setWsStatus("live");
        reconnectCount.current = 0;  // ✅ Reset on success
      }
    };

    ws.onmessage = (event) => {
      if (unmounted.current) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case "holdings_update":
          if (Array.isArray(msg.items) && msg.items.length > 0) {
            onHoldingsUpdate(msg.items);
          }
          break;
        case "summary_update":
          if (msg.summary) {
            onSummaryUpdate(msg.summary);
          }
          break;
        case "status":
          if (msg.message === "NO_STRATEGY") {
            setWsStatus("no_strategy");
          }
          break;
        case "error":
          if (msg.message === "Unauthorized") {
            onUnauthorized();
          }
          break;
        default:
          break;
      }
    };

    ws.onerror = () => {
      if (!unmounted.current) setWsStatus("disconnected");
    };

    ws.onclose = (event) => {
      if (unmounted.current) return;
      
      if (event.code === 4401) {
        setWsStatus("disconnected");
        onUnauthorized();
        return;
      }
      
      reconnectCount.current++;  // ✅ Increment counter
      
      // ✅ Stop after max retries
      if (reconnectCount.current >= MAX_RECONNECTS) {
        console.error("Max WebSocket reconnection attempts reached");
        setWsStatus("disconnected");
        return;
      }
      
      setWsStatus("disconnected");
      const backoffDelay = 4000 * reconnectCount.current;  // ✅ Exponential backoff
      reconnectTimer.current = setTimeout(() => {
        if (!unmounted.current) connect();
      }, backoffDelay);
    };
  }, [enabled, onHoldingsUpdate, onSummaryUpdate, onUnauthorized]);

  useEffect(() => {
    unmounted.current = false;
    if (enabled) connect();

    return () => {
      unmounted.current = true;
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [enabled, connect]);

  return wsStatus;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmt = (n) => "₹" + Number(n).toLocaleString("en-IN");

// ✅ Holdings-specific: up to 2 decimal places
const fmt2 = (n) => {
  const num = Number(n);
  if (!Number.isFinite(num)) return "₹0";
  const abs = Math.abs(num).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${num < 0 ? "-" : ""}₹${abs}`;
};

const num2 = (n) => {
  const num = Number(n);
  if (!Number.isFinite(num)) return "0";
  return num.toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
};

// ─── STATUS CONFIG ────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  active:  { label: "Active",  bg: "#dcfce7", color: "#15803d", dot: "#22c55e", ring: "#bbf7d0" },
  paused:  { label: "Paused",  bg: "#fef9c3", color: "#a16207", dot: "#eab308", ring: "#fef08a" },
  stopped: { label: "Stopped", bg: "#fee2e2", color: "#b91c1c", dot: "#ef4444", ring: "#fecaca" },
};

// ─── WS STATUS PILL ───────────────────────────────────────────────────────────
function WsStatusPill({ status }) {
  const map = {
    live:         { label: "Live",         color: "#15803d", dot: "#22c55e", bg: "#dcfce7", border: "#bbf7d0", pulse: true },
    connecting:   { label: "Connecting…",  color: "#a16207", dot: "#eab308", bg: "#fef9c3", border: "#fef08a", pulse: false },
    disconnected: { label: "Disconnected", color: "#b91c1c", dot: "#ef4444", bg: "#fee2e2", border: "#fecaca", pulse: false },
    no_strategy:  { label: "No Strategy",  color: "#6b7280", dot: "#9ca3af", bg: "#f3f4f6", border: "#e5e7eb", pulse: false },
  };
  const cfg = map[status] || map.disconnected;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 9px", borderRadius: 20,
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      fontSize: 10, fontWeight: 700, color: cfg.color,
      fontFamily: SYS, letterSpacing: "0.03em",
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: "50%",
        background: cfg.dot, display: "inline-block",
        animation: cfg.pulse ? "pulse 2s ease-in-out infinite" : "none",
      }} />
      {cfg.label}
    </span>
  );
}

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.stopped;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 10px", borderRadius: 20,
      background: cfg.bg, border: `1px solid ${cfg.ring}`,
      fontSize: 11, fontWeight: 700, color: cfg.color, fontFamily: SYS,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%", background: cfg.dot, display: "inline-block",
        animation: status === "active" ? "pulse 2s ease-in-out infinite" : "none",
      }} />
      {cfg.label}
    </span>
  );
}

// ─── CONFIRM MODAL ────────────────────────────────────────────────────────────
function ConfirmModal({ action, onConfirm, onCancel }) {
  const map = {
    stop: {
      title: "Stop Strategy",
      desc: (
        <div>
          <p style={{ marginBottom: 10, fontSize: 13, color: "#555", lineHeight: 1.6 }}>
            This will <strong>immediately halt</strong> the strategy. <strong>All holdings remain in your account</strong> — you must manually sell them in your broker.
          </p>
          <div style={{
            display: "flex", gap: 8, alignItems: "flex-start",
            background: "#fef9c3", border: "1px solid #fde68a",
            borderRadius: 6, padding: "10px 12px",
          }}>
            <span style={{ fontSize: 15, flexShrink: 0 }}>⚠</span>
            <span style={{ fontSize: 12, color: "#92400e", lineHeight: 1.55 }}>
              <strong>Action cannot be undone.</strong> After stopping, you will need to redeploy to restart the strategy.
            </span>
          </div>
        </div>
      ),
      btn: "Stop Strategy Now", btnBg: "#dc2626",
    },
    pause: {
      title: "Pause Strategy",
      desc: "Rebalancing will be paused. Current holdings remain unchanged and no new trades will be placed until resumed.",
      btn: "Pause Strategy", btnBg: "#d97706",
    },
    resume: {
      title: "Resume Strategy",
      desc: "Strategy will resume rebalancing on the next scheduled date. No immediate trades will be placed.",
      btn: "Resume Strategy", btnBg: "#16a34a",
    },
    restart: {
      title: "Restart Strategy",
      desc: "Strategy will be restarted from today using your existing configuration. Rebalancing will resume on the next scheduled date.",
      btn: "Restart Strategy", btnBg: "#111",
    },
  };

  const cfg = map[action];
  if (!cfg) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.38)", backdropFilter: "blur(3px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        background: "#fff", borderRadius: 10, padding: "26px 26px 22px",
        width: "100%", maxWidth: 400,
        boxShadow: "0 16px 48px rgba(0,0,0,0.14)", fontFamily: SYS,
        animation: "panelIn 0.2s ease both",
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#111", marginBottom: 10 }}>{cfg.title}</div>
        <div style={{ marginBottom: 22 }}>
          {typeof cfg.desc === "string"
            ? <p style={{ fontSize: 13, color: "#555", lineHeight: 1.6 }}>{cfg.desc}</p>
            : cfg.desc}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "10px", borderRadius: 6, border: "1px solid #ccc", background: "#fff", fontSize: 13, fontWeight: 600, color: "#444", cursor: "pointer", fontFamily: SYS }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ flex: 2, padding: "10px", borderRadius: 6, border: "none", background: cfg.btnBg, fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: SYS }}>
            {cfg.btn}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SPINNER ──────────────────────────────────────────────────────────────────
function Spinner({ size = 32 }) {
  return (
    <div style={{
      width: size, height: size,
      border: "2.5px solid #e8e8e8", borderTopColor: "#333",
      borderRadius: "50%", animation: "dbSpin 0.7s linear infinite",
    }} />
  );
}

// ─── ERROR BANNER ─────────────────────────────────────────────────────────────
function ErrorBanner({ message, onDismiss }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 7,
      padding: "10px 14px", marginBottom: 18, gap: 12,
    }}>
      <span style={{ fontSize: 12, color: "#b91c1c", fontFamily: SYS }}>⚠ {message}</span>
      {onDismiss && (
        <button onClick={onDismiss} style={{ background: "none", border: "none", color: "#b91c1c", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0, fontFamily: SYS }}>×</button>
      )}
    </div>
  );
}

// ─── NO STRATEGY ─────────────────────────────────────────────────────────────
function NoStrategy({ onDeploy }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      minHeight: "46vh", textAlign: "center", padding: "40px 20px",
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: "50%",
        border: "1.5px solid #e0e0e0", background: "#f5f5f5",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 24, color: "#999", marginBottom: 20,
      }}>◈</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontFamily: SYS }}>
        No Strategy Active
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#111", marginBottom: 8, fontFamily: SYS }}>
        No Strategy Deployed
      </div>
      <div style={{ width: 36, height: 1, background: "#e0e0e0", margin: "0 auto 16px" }} />
      <div style={{ fontSize: 13, color: "#666", lineHeight: 1.7, maxWidth: 360, marginBottom: 28, fontFamily: SYS }}>
        Deploy a momentum strategy to activate live tracking, portfolio analytics, and holdings data.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", maxWidth: 360, marginBottom: 28, textAlign: "left" }}>
        {[
          ["1", "Choose a momentum strategy from the library"],
          ["2", "Configure risk parameters and capital allocation"],
          ["3", "Deploy — dashboard activates automatically"],
        ].map(([num, text]) => (
          <div key={num} style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            padding: "10px 14px", background: "#fff", border: "1px solid #e8e8e8", borderRadius: 7,
          }}>
            <span style={{
              width: 20, height: 20, borderRadius: 5, background: "#222", color: "#fff",
              fontSize: 10, fontWeight: 700, fontFamily: SYS,
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0, marginTop: 1,
            }}>{num}</span>
            <span style={{ fontSize: 12, color: "#555", lineHeight: 1.55, fontFamily: SYS }}>{text}</span>
          </div>
        ))}
      </div>
      <button
        onClick={onDeploy}
        style={{
          padding: "11px 28px", borderRadius: 7, border: "none",
          background: "#222", color: "#fff",
          fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
          cursor: "pointer", fontFamily: SYS,
        }}
        onMouseEnter={e => e.currentTarget.style.background = "#3a3a3a"}
        onMouseLeave={e => e.currentTarget.style.background = "#222"}
      >
        Deploy Strategy
      </button>
    </div>
  );
}

// ─── STAT CARD ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, pnlType, delay, flash }) {
  const isPos = pnlType === "pos";
  const isNeg = pnlType === "neg";
  return (
    <div style={{
      background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8,
      padding: "18px 20px",
      opacity: 0, transform: "translateY(8px)",
      animation: `statIn 0.35s ease ${delay} forwards`,
      transition: "background 0.4s ease",
      ...(flash ? { background: "#f0fdf4" } : {}),
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10, fontFamily: SYS }}>{label}</div>
      <div style={{
        fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 6, fontFamily: MONO,
        color: isPos ? "#1b6f3e" : isNeg ? "#c62828" : "#111",
        transition: "color 0.3s",
      }}>{value}</div>
      {sub && (
        pnlType
          ? <span style={{ display: "inline-block", fontSize: 11, fontWeight: 600, fontFamily: MONO, padding: "2px 8px", borderRadius: 4, background: isPos ? "#ebf7ef" : "#fdecea", color: isPos ? "#1b6f3e" : "#c62828" }}>{sub}</span>
          : <span style={{ fontSize: 11, color: "#999", fontFamily: MONO }}>{sub}</span>
      )}
    </div>
  );
}

// ─── CHART TOOLTIP ────────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "#fff", border: "1px solid #e0e0e0",
      borderRadius: 7, padding: "9px 13px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.09)", fontFamily: SYS,
    }}>
      <div style={{ fontSize: 10, color: "#888", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#111", fontFamily: MONO }}>{fmt(payload[0].value)}</div>
    </div>
  );
}

// ─── ACTION BUTTON ────────────────────────────────────────────────────────────
function ActionBtn({ label, icon, onClick, bg, color, border }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "7px 13px", borderRadius: 6,
        border: border || "none",
        background: bg, color,
        fontSize: 11, fontWeight: 700, cursor: "pointer",
        letterSpacing: "0.03em", textTransform: "uppercase",
        fontFamily: SYS, transition: "opacity 0.13s, transform 0.1s",
        opacity: hovered ? 0.82 : 1,
        transform: hovered ? "translateY(-1px)" : "none",
      }}
    >
      <span style={{ fontSize: 10 }}>{icon}</span> {label}
    </button>
  );
}

// ─── STRATEGY PANEL ───────────────────────────────────────────────────────────
function StrategyPanel({ strategy, onAction }) {
  const metrics = [
    ["Universe",       strategy.universe],
    ["No. of Stocks",  `${strategy.numStocks} stocks`],
    ["Price Cap",      strategy.priceCap ? fmt(strategy.priceCap) : "No limit"],
    ["Lookback 1",     `${strategy.lookback1} months`],
    ["Lookback 2",     `${strategy.lookback2} months`],
    ["Capital",        fmtCompact(strategy.capital)],
    ["Rebalance",      strategy.rebalanceType === "monthly" ? "Monthly" : "Weekly"],
    ["Frequency",      `Every ${strategy.frequency} ${strategy.rebalanceType === "monthly" ? "month" : "week"}${strategy.frequency > 1 ? "s" : ""}`],
    ["Started",        strategy.startingDate],
    ["Last Rebalance", strategy.lastRebalanced],
    ["Next Rebalance", strategy.nextRebalance],
  ];

  const isActive  = strategy.status === "active";
  const isPaused  = strategy.status === "paused";
  const isStopped = strategy.status === "stopped";

  return (
    <div style={{
      background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8,
      overflow: "hidden", marginBottom: 24,
      animation: "panelIn 0.3s ease both",
    }}>
      <div style={{
        padding: "13px 20px", borderBottom: "1px solid #ebebeb", background: "#f8f8f8",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#333", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: SYS }}>
            Deployed Strategy
          </span>
          <StatusBadge status={strategy.status} />
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          {(isPaused || isStopped) && (
            <ActionBtn label={isStopped ? "Restart" : "Resume"} icon="▶" onClick={() => onAction(isStopped ? "restart" : "resume")} bg="#111" color="#fff" />
          )}
          {isActive && (
            <ActionBtn label="Pause" icon="⏸" onClick={() => onAction("pause")} bg="#fff" color="#555" border="1px solid #ccc" />
          )}
          {!isStopped && (
            <ActionBtn label="Stop" icon="■" onClick={() => onAction("stop")} bg="#fff" color="#c62828" border="1px solid #fca5a5" />
          )}
        </div>
      </div>

      <div style={{ padding: "4px 8px 8px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))" }}>
          {metrics.map(([key, val]) => (
            <div key={key} style={{ padding: "10px 12px", borderBottom: "1px solid #f5f5f5" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "#aaa", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4, fontFamily: SYS }}>{key}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#111", fontFamily: MONO }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── PRICE SOURCE BADGE ───────────────────────────────────────────────────────
function PriceSourceBadge({ source }) {
  if (!source) return null;
  const isLive = source === "live";
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
      padding: "2px 6px", borderRadius: 4,
      background: isLive ? "#dcfce7" : "#f3f4f6",
      color: isLive ? "#15803d" : "#6b7280",
      fontFamily: SYS, marginLeft: 6,
    }}>
      {isLive ? "● Live" : "Delayed"}
    </span>
  );
}

// ─── [NEW] DAY-ZERO BANNER ────────────────────────────────────────────────────
// Shown when strategy is deployed but no trades have been placed yet.
// Purely additive — rendered only when holdings.length === 0 && invested === 0.
function DayZeroBanner({ nextRebalance }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 12,
      background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8,
      padding: "14px 18px", marginBottom: 24, fontFamily: SYS,
    }}>
      <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>🕐</span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1e40af", marginBottom: 4 }}>
          Awaiting First Trade
        </div>
        <div style={{ fontSize: 12, color: "#3b5bdb", lineHeight: 1.65 }}>
          Your strategy is live and configured. Holdings and portfolio value will appear here after
          the first rebalance
          {nextRebalance ? <> on <strong>{nextRebalance}</strong></> : null}.
          {" "}No action is needed from your side.
        </div>
        {nextRebalance && (
          <div style={{ marginTop: 8, fontSize: 11, color: "#1d4ed8", fontWeight: 600 }}>
            First rebalance scheduled: {nextRebalance}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── [NEW] HOLDINGS EMPTY STATE ───────────────────────────────────────────────
// Rendered inside <tbody> when holdings array is empty.
function HoldingsEmptyRow() {
  return (
    <tr>
      <td colSpan={7} style={{
        padding: "36px 20px", textAlign: "center",
        fontFamily: SYS, color: "#aaa", fontSize: 13,
      }}>
        No holdings yet — positions will appear after the first rebalance.
      </td>
    </tr>
  );
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
const MAX_AUTO_RETRIES = 2;
const RETRY_DELAY_MS   = 1000;

export default function Dashboard() {
  const navigate = useNavigate();

  const [portfolio,     setPortfolio]     = useState(null);
  const [chartData,     setChartData]     = useState([]);
  const [view,          setView]          = useState(null);
  const [range,         setRange]         = useState("1M");
  const [loading,       setLoading]       = useState(true);
  const [chartLoading,  setChartLoading]  = useState(false);
  const [mounted,       setMounted]       = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [error,         setError]         = useState(null);

  const [offline,       setOffline]       = useState(false);
  const [retrying,      setRetrying]      = useState(false);
  const [retryAttempt,  setRetryAttempt]  = useState(0);
  const retryTimer = useRef(null);

  const [flashValue, setFlashValue] = useState(false);

  const fetchPortfolio = useCallback(async () => {
    try {
      const data = await api.getPortfolio();
      setPortfolio(data);
      setOffline(false);
      setRetrying(false);
      setRetryAttempt(0);
      setLoading(false);
      setTimeout(() => setMounted(true), 40);
    } catch (err) {
      if (err.message === "UNAUTHORIZED") {
        navigate("/login");
        return;
      }
      setLoading(false);
      setOffline(true);
      setRetrying(false);
    }
  }, [navigate]);

  const scheduleAutoRetry = useCallback((attempt) => {
    if (attempt >= MAX_AUTO_RETRIES) {
      navigate("/offline");
      return;
    }
    retryTimer.current = setTimeout(async () => {
      const next = attempt + 1;
      setRetryAttempt(next);
      setRetrying(true);
      try {
        const data = await api.getPortfolio();
        setPortfolio(data);
        setOffline(false);
        setRetrying(false);
        setRetryAttempt(0);
        setLoading(false);
        setTimeout(() => setMounted(true), 40);
      } catch (err) {
        if (err.message === "UNAUTHORIZED") { navigate("/login"); return; }
        setRetrying(false);
        scheduleAutoRetry(next);
      }
    }, RETRY_DELAY_MS);
  }, [navigate]);

  useEffect(() => {
    fetchPortfolio().then(() => {}).catch(() => {});
    return () => clearTimeout(retryTimer.current);
  }, []);

  useEffect(() => {
    if (!offline) return;
    scheduleAutoRetry(retryAttempt);
    return () => clearTimeout(retryTimer.current);
  }, [offline]);

  const handleManualRetry = useCallback(() => {
    clearTimeout(retryTimer.current);
    setRetryAttempt(0);
    setRetrying(true);
    fetchPortfolio();
  }, [fetchPortfolio]);

  useEffect(() => {
    if (view !== "chart") return;
    setChartLoading(true);
    api.getChartData(range)
      .then(data => {
        // ✅ VALIDATE CHART DATA
        const cleanData = (data ?? [])
          .filter(d => {
            const val = Number(d.value);
            return Number.isFinite(val) && val > 0 && d.date;
          })
          .sort((a, b) => new Date(a.date) - new Date(b.date));
        
        setChartData(cleanData);
        setChartLoading(false);
      })
      .catch(err => {
        setChartLoading(false);
        if (err.message === "UNAUTHORIZED") navigate("/login");
        else setError(err.message || "Failed to load chart.");
      });
  }, [view, range, navigate]);

  const handleHoldingsUpdate = useCallback((items) => {
    setPortfolio(prev => {
      if (!prev?.holdings) return prev;
      const updatedHoldings = prev.holdings.map(h => {
        const update = items.find(i => i.symbol === h.symbol);
        if (!update) return h;
        
        // ✅ VALIDATE ALL INCOMING DATA
        const ltp = Number(update.ltp);
        if (!Number.isFinite(ltp) || ltp <= 0) {
          console.warn(`Invalid LTP for ${h.symbol}:`, update.ltp);
          return h;  // Skip invalid update
        }
        
        const avgPrice = Number(h.avgPrice);
        if (!Number.isFinite(avgPrice) || avgPrice <= 0) {
          console.warn(`Invalid avgPrice for ${h.symbol}:`, h.avgPrice);
          return h;
        }
        
        const qty = Number(h.qty);
        if (!Number.isFinite(qty) || qty <= 0) {
          console.warn(`Invalid qty for ${h.symbol}:`, h.qty);
          return h;
        }
        
        const value = ltp * qty;
        const pnl   = value - avgPrice * qty;
        const pnlPct = ((ltp - avgPrice) / avgPrice) * 100;
        
        return { 
          ...h, 
          ltp, 
          value, 
          pnl, 
          pnlPct, 
          priceSource: "live", 
          priceTs: update.ts 
        };
      });
      return { ...prev, holdings: updatedHoldings };
    });
  }, []);

  const handleSummaryUpdate = useCallback((summary) => {
    setPortfolio(prev => {
      if (!prev?.summary) return prev;
      
      // ✅ VALIDATE INCOMING DATA ONLY — NO RECALCULATION
      const newCurrentValue = Number(summary.currentValue);
      const newCash = Number(summary.cash);
      const newPnl = Number(summary.pnl);
      const newPnlPct = Number(summary.pnlPct);
      const newInvested = Number(summary.invested);
      
      if (!Number.isFinite(newCurrentValue)) {
        console.warn("Invalid currentValue:", summary.currentValue);
        return prev;
      }
      if (!Number.isFinite(newCash)) {
        console.warn("Invalid cash:", summary.cash);
        return prev;
      }
      if (!Number.isFinite(newPnl)) {
        console.warn("Invalid pnl:", summary.pnl);
        return prev;
      }
      if (!Number.isFinite(newPnlPct)) {
        console.warn("Invalid pnlPct:", summary.pnlPct);
        return prev;
      }
      if (!Number.isFinite(newInvested)) {
        console.warn("Invalid invested:", summary.invested);
        return prev;
      }
      
      return {
        ...prev,
        summary: {
          ...prev.summary,
          invested: newInvested,
          currentValue: newCurrentValue,
          cash: newCash,
          pnl: newPnl,           // ← Use backend value directly
          pnlPct: newPnlPct,     // ← Use backend value directly
          priceSource: "live",
        },
      };
    });
    setFlashValue(true);
    setTimeout(() => setFlashValue(false), 700);
  }, []);

  const handleUnauthorized = useCallback(() => {
    navigate("/login");
  }, [navigate]);

  const wsEnabled = !!(
    portfolio?.strategyDeployed &&
    portfolio?.strategy &&
    portfolio?.strategy?.status === "active"
  );

  const wsStatus = useLiveWebSocket({
    enabled: wsEnabled,
    onHoldingsUpdate: handleHoldingsUpdate,
    onSummaryUpdate:  handleSummaryUpdate,
    onUnauthorized:   handleUnauthorized,
  });

  const handleViewToggle = v => setView(prev => prev === v ? null : v);

  async function handleConfirm() {
    const action = confirmAction;
    setConfirmAction(null);
    setActionLoading(true);
    setError(null); // clear stale error before new action

    try {
      await api.postAction(action);

      const fresh = await api.getPortfolio();
      setPortfolio(fresh);
      setView(null);

      if (action === "stop" && fresh?.strategyDeployed) {
        setError("Stop request sent, but strategy is still deployed on server. Please check backend stop logic.");
      }
    } catch (err) {
      if (err.message === "UNAUTHORIZED") navigate("/login");
      else setError("Action failed. Please try again.");
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) return (
    <div style={{
      minHeight: "calc(100vh - 56px)", background: "#f2f2f2",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <Spinner size={34} />
    </div>
  );

  if (!portfolio) {
    if (offline) {
      return (
        <div style={{
          minHeight: "calc(100vh - 56px)", background: "#f2f2f2",
          display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 20,
        }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#333", marginBottom: 8 }}>
              Connection Lost
            </div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 20 }}>
              Unable to load portfolio. Retrying automatically...
            </div>
            <button
              onClick={handleManualRetry}
              style={{
                padding: "10px 24px", borderRadius: 6, border: "none",
                background: "#222", color: "#fff",
                fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: SYS,
              }}
            >
              Retry Now
            </button>
          </div>
        </div>
      );
    }
  }

  const { user, summary, holdings, strategyDeployed, strategy } = portfolio;
  const pnlPos = (summary?.pnl ?? 0) >= 0;

  // ✅ Day-zero only when strategy is ACTIVE and no holdings exist yet
  const holdingsCount = Array.isArray(holdings) ? holdings.length : 0;
  const isDayZero = Boolean(
    strategyDeployed &&
    strategy?.status === "active" &&
    holdingsCount === 0
  );

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .db-root { padding: 28px 28px 72px; font-family: ${SYS}; }
        .db-wrap {
          max-width: 1100px; margin: 0 auto;
          opacity: 0; transform: translateY(10px);
          transition: opacity 0.35s ease, transform 0.35s ease;
        }
        .db-wrap.mounted { opacity: 1; transform: translateY(0); }

        .db-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
        @media (max-width: 860px) { .db-summary { grid-template-columns: repeat(2, 1fr); } .db-root { padding: 18px 14px 60px; } }
        @media (max-width: 480px) { .db-summary { grid-template-columns: 1fr; } }

        @keyframes statIn  { to { opacity: 1; transform: translateY(0); } }
        @keyframes panelIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes dbSpin  { to { transform: rotate(360deg); } }
        @keyframes pulse   { 0%,100% { box-shadow: 0 0 0 2px #bbf7d0; } 50% { box-shadow: 0 0 0 4px #dcfce7; } }
        @keyframes ltpFlash { 0% { background: #f0fdf4; } 100% { background: transparent; } }

        .db-toggles { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
        .db-toggle {
          font-size: 12px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
          padding: 8px 18px; border-radius: 6px; border: none; cursor: pointer;
          display: flex; align-items: center; gap: 7px; transition: all 0.14s; font-family: ${SYS};
        }
        .db-toggle-off { background: #fff; color: #555; border: 1px solid #ccc; }
        .db-toggle-off:hover { background: #f5f5f5; border-color: #999; }
        .db-toggle-on  { background: #222; color: #fff; }

        .db-panel { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; animation: panelIn 0.3s ease both; }
        .db-panel-header {
          padding: 13px 20px; border-bottom: 1px solid #ebebeb; background: #f8f8f8;
          display: flex; align-items: center; justify-content: space-between;
        }
        .db-panel-title { font-size: 12px; font-weight: 700; color: #333; text-transform: uppercase; letter-spacing: 0.05em; }

        .db-ranges { display: flex; gap: 3px; }
        .db-range { font-family: ${MONO}; font-size: 11px; padding: 4px 10px; border-radius: 5px; border: none; cursor: pointer; transition: all 0.13s; }
        .db-range-on  { background: #222; color: #fff; }
        .db-range-off { background: transparent; color: #888; }
        .db-range-off:hover { background: #f0f0f0; color: #333; }

        .db-table { width: 100%; border-collapse: collapse; }
        .db-table thead th {
          font-family: ${MONO}; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
          color: #888; padding: 11px 18px; font-weight: 600; text-align: right;
          border-bottom: 1px solid #ebebeb; background: #f8f8f8;
        }
        .db-table thead th:first-child { text-align: left; }
        .db-table tbody tr { border-bottom: 1px solid #f0f0f0; transition: background 0.13s; }
        .db-table tbody tr:last-child { border-bottom: none; }
        .db-table tbody tr:hover { background: #fafafa; }
        .db-table td { padding: 11px 18px; font-family: ${MONO}; font-size: 13px; color: #333; text-align: right; vertical-align: middle; }
        .db-table td:first-child { text-align: left; }
        .db-sym      { font-weight: 700; color: #111; font-size: 13px; }
        .db-sym-name { font-size: 10px; color: #999; margin-top: 2px; }
        .db-pnl-pct  { font-size: 10px; margin-top: 2px; }
        .pos-text { color: #1b6f3e; }
        .neg-text { color: #c62828; }
        .ltp-flash { animation: ltpFlash 0.7s ease; }
      `}</style>

      {confirmAction && (
        <ConfirmModal action={confirmAction} onConfirm={handleConfirm} onCancel={() => setConfirmAction(null)} />
      )}

      {actionLoading && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 999,
          background: "rgba(255,255,255,0.6)", backdropFilter: "blur(2px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Spinner size={36} />
        </div>
      )}

      <div className="db-root">
        <div className={`db-wrap ${mounted ? "mounted" : ""}`}>

          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

          <div style={{
            marginBottom: 22,
            display: "flex", alignItems: "flex-start",
            justifyContent: "space-between", flexWrap: "wrap", gap: 10,
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>
                Welcome back
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#111" }}>
                {user.name}
              </div>
            </div>
            {strategyDeployed && strategy && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#999", fontFamily: SYS }}>Strategy</span>
                <StatusBadge status={strategy.status} />
                <WsStatusPill status={wsStatus} />
              </div>
            )}
          </div>

          {!strategyDeployed ? (
            <NoStrategy onDeploy={() => navigate("/deploy")} />
          ) : (
            <>
              {strategy && (
                <StrategyPanel strategy={strategy} onAction={setConfirmAction} />
              )}

              {/* ── [NEW] Day-zero banner — shown only before first rebalance ── */}
              {isDayZero && (
                <DayZeroBanner nextRebalance={strategy?.nextRebalance} />
              )}

              {/* ── Summary stat cards ── */}
              {/* [NEW] Cards hidden on day-zero so ₹0/₹0/+₹0 is never shown */}
              {summary && !isDayZero && (
                <div className="db-summary">
                  <StatCard
                    label="Invested"
                    value={fmtCompact(summary.invested)}
                    sub={fmt(summary.invested)}
                    delay="0.04s"
                  />
                  <StatCard
                    label="Current Value"
                    value={fmtCompact(summary.currentValue)}
                    sub={
                      <>
                        {fmt(summary.currentValue)}
                        <PriceSourceBadge source={summary.priceSource} />
                      </>
                    }
                    delay="0.09s"
                    flash={flashValue}
                  />
                  <StatCard
                    label="P&L"
                    value={(pnlPos ? "+" : "") + fmtCompact(summary.pnl)}
                    sub={(pnlPos ? "▲ " : "▼ ") + Math.abs(summary.pnlPct).toFixed(2) + "%"}
                    pnlType={pnlPos ? "pos" : "neg"}
                    delay="0.14s"
                    flash={flashValue}
                  />
                  <StatCard
                    label="Cash Available"
                    value={fmtCompact(summary.cash)}
                    sub={fmt(summary.cash)}
                    delay="0.19s"
                  />
                </div>
              )}

              {/* ── Toggle buttons ── */}
              <div className="db-toggles">
                {/* [NEW] Chart toggle hidden on day-zero — no data to show */}
                {!isDayZero && (
                  <button
                    className={`db-toggle ${view === "chart" ? "db-toggle-on" : "db-toggle-off"}`}
                    onClick={() => handleViewToggle("chart")}
                  >
                    <span>▲</span> Portfolio Chart
                  </button>
                )}
                <button
                  className={`db-toggle ${view === "holdings" ? "db-toggle-on" : "db-toggle-off"}`}
                  onClick={() => handleViewToggle("holdings")}
                >
                  <span>≡</span> Holdings
                </button>
              </div>

              {/* ── Chart panel ── */}
              {view === "chart" && !isDayZero && (
                <div className="db-panel" style={{ marginBottom: 20 }}>
                  <div className="db-panel-header">
                    <span className="db-panel-title">Portfolio Value</span>
                    <div className="db-ranges">
                      {CHART_RANGES.map(r => (
                        <button
                          key={r}
                          className={`db-range ${range === r ? "db-range-on" : "db-range-off"}`}
                          onClick={() => setRange(r)}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ padding: "20px 10px 14px" }}>
                    {chartLoading ? (
                      <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Spinner size={28} />
                      </div>
                    ) : chartData?.length === 0 ? (
                      <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: "#999", fontSize: 13 }}>
                        No chart data available for this range
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height={270}>
                        <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                          <defs>
                            <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%"   stopColor="#3b5bdb" stopOpacity={0.15} />
                              <stop offset="100%" stopColor="#3b5bdb" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke="#f0f0f0" vertical={false} />
                          <XAxis
                            dataKey="date"
                            tick={{ fontFamily: MONO, fontSize: 10, fill: "#aaa" }}
                            tickLine={false} axisLine={false} interval="preserveStartEnd"
                          />
                          <YAxis
                            tick={{ fontFamily: MONO, fontSize: 10, fill: "#aaa" }}
                            tickLine={false} axisLine={false}
                            tickFormatter={v => "₹" + (v / 100000).toFixed(1) + "L"}
                            width={58}
                          />
                          <Tooltip content={<ChartTooltip />} />
                          <Area
                            type="monotone" dataKey="value"
                            stroke="#3b5bdb" strokeWidth={2}
                            fill="url(#chartGrad)" dot={false}
                            activeDot={{ r: 4, fill: "#3b5bdb", stroke: "#fff", strokeWidth: 2 }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
              )}

              {/* ── Holdings panel ── */}
              {view === "holdings" && (
                <div className="db-panel">
                  <div className="db-panel-header">
                    <span className="db-panel-title">Current Holdings</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {holdings?.[0]?.priceSource && (
                        <PriceSourceBadge source={holdings[0].priceSource} />
                      )}
                      <span style={{ fontSize: 11, color: "#999", fontFamily: MONO }}>
                        {holdings?.length ?? 0} positions
                      </span>
                    </div>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table className="db-table">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Qty</th>
                          <th>Avg Price</th>
                          <th>LTP</th>
                          <th>Value</th>
                          <th>P&L</th>
                          <th>Day Chg</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(holdings ?? []).length === 0
                          ? <HoldingsEmptyRow />  /* [NEW] empty state row */
                          : (holdings ?? []).map(h => {
                            const pos = h.pnl >= 0;

                            const dc = Number(h.dayChange);
                            const dayChange = Number.isFinite(dc) ? dc : 0;
                            const dayPos = dayChange >= 0;

                            return (
                              <tr key={h.symbol}>
                                <td>
                                  <div className="db-sym">{h.symbol}</div>
                                  {h.name && <div className="db-sym-name">{h.name}</div>}
                                </td>
                                <td>{num2(h.qty)}</td>
                                <td>{fmt2(h.avgPrice)}</td>
                                <td
                                  style={{ color: "#111", fontWeight: 600 }}
                                  key={`ltp-${h.symbol}-${h.priceTs}`}
                                  className={h.priceSource === "live" ? "ltp-flash" : ""}
                                >
                                  {fmt2(h.ltp)}
                                </td>
                                <td>{fmt2(h.value)}</td>
                                <td>
                                  <span className={pos ? "pos-text" : "neg-text"} style={{ fontWeight: 600 }}>
                                    {pos ? "+" : ""}{fmt2(h.pnl)}
                                  </span>
                                  <div className={`db-pnl-pct ${pos ? "pos-text" : "neg-text"}`}>
                                    {pos ? "▲" : "▼"} {Math.abs(h.pnlPct).toFixed(2)}%
                                  </div>
                                </td>
                                <td className={dayPos ? "pos-text" : "neg-text"} style={{ fontWeight: 600 }}>
                                  {dayPos ? "+" : ""}{dayChange.toFixed(2)}%
                                </td>
                              </tr>
                            );
                          })
                        }
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

        </div>
      </div>
    </>
  );
}