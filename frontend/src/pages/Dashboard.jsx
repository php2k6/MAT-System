import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid
} from "recharts";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const WS_BASE_URL  = import.meta.env.VITE_WS_BASE_URL
  || API_BASE_URL.replace(/^https?/, "ws").replace(/^http/, "ws");

const CHART_RANGES = ["1W", "1M", "3M", "1Y", "3Y", "5Y", "10Y", "MAX"];

const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

// ─── API SERVICE LAYER ────────────────────────────────────────────────────────
const api = {
  /**
   * GET /api/portfolio
   * Auth via session cookie (credentials: "include")
   */
  getPortfolio: async () => {
    const res = await fetch(`${API_BASE_URL}/api/portfolio`, {
      method: "GET",
      credentials: "include",          // sends session cookie
    });
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    if (!res.ok) throw new Error(`Portfolio fetch failed: ${res.status}`);
    return res.json();
  },

  /**
   * GET /api/portfolio/chart?range=1M
   * Auth via session cookie
   */
  getChartData: async (range = "1M") => {
    const res = await fetch(
      `${API_BASE_URL}/api/portfolio/chart?range=${encodeURIComponent(range)}`,
      { method: "GET", credentials: "include" }
    );
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    if (res.status === 400) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.detail?.message || "Invalid range");
    }
    if (!res.ok) throw new Error(`Chart fetch failed: ${res.status}`);
    return res.json(); // [{ date, value }, ...]
  },

  /**
   * POST /api/strategy/action
   * Body: { action: "pause" | "stop" | "resume" | "restart" }
   * Adjust the path to match your actual backend endpoint.
   */
  postAction: async (action) => {
    const res = await fetch(`${API_BASE_URL}/api/strategy/action`, {
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
/**
 * Connects to /api/live/ws via WebSocket.
 * Session cookie is sent automatically (same-origin or cookie-forwarding).
 *
 * Handles:
 *   { type: "error",           message: "Unauthorized" }   → closes with 4401
 *   { type: "status",          message: "NO_STRATEGY" }    → no-op / periodic ping
 *   { type: "holdings_update", timestamp, items: [{symbol, ltp, ts}] }
 *   { type: "summary_update",  timestamp, summary: {currentValue, cash, equity} }
 *
 * onHoldingsUpdate(items)  — called with changed symbols only
 * onSummaryUpdate(summary) — called with updated summary fields
 * onUnauthorized()         — called when server closes with 4401
 */
function useLiveWebSocket({ enabled, onHoldingsUpdate, onSummaryUpdate, onUnauthorized }) {
  const wsRef          = useRef(null);
  const reconnectTimer = useRef(null);
  const unmounted      = useRef(false);
  const [wsStatus, setWsStatus] = useState("disconnected"); // "connecting" | "live" | "disconnected" | "no_strategy"

  const connect = useCallback(() => {
    if (!enabled || unmounted.current) return;
    if (wsRef.current && wsRef.current.readyState < 2) return; // already open/connecting

    setWsStatus("connecting");
    const ws = new WebSocket(`${WS_BASE_URL}/api/live/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!unmounted.current) setWsStatus("live");
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
          // "NO_STRATEGY" — nothing to update live, just mark status
          if (msg.message === "NO_STRATEGY") {
            setWsStatus("no_strategy");
          }
          break;

        case "error":
          // Server will close socket after this
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

      // 4401 = unauthorized — don't reconnect
      if (event.code === 4401) {
        setWsStatus("disconnected");
        onUnauthorized();
        return;
      }

      setWsStatus("disconnected");

      // Auto-reconnect after 4 s
      reconnectTimer.current = setTimeout(() => {
        if (!unmounted.current) connect();
      }, 4000);
    };
  }, [enabled, onHoldingsUpdate, onSummaryUpdate, onUnauthorized]);

  useEffect(() => {
    unmounted.current = false;
    if (enabled) connect();

    return () => {
      unmounted.current = true;
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on unmount
        wsRef.current.close();
      }
    };
  }, [enabled, connect]);

  return wsStatus;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmt = (n) => "₹" + Number(n).toLocaleString("en-IN");
const fmtCompact = (n) => {
  const abs  = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 10000000) return sign + "₹" + (abs / 10000000).toFixed(2) + "Cr";
  if (abs >= 100000)   return sign + "₹" + (abs / 100000).toFixed(2) + "L";
  if (abs >= 1000)     return sign + "₹" + (abs / 1000).toFixed(1) + "K";
  return sign + "₹" + abs;
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
            This will permanently halt the strategy and clear all dashboard data. You will need to redeploy to start again.
          </p>
          <div style={{
            display: "flex", gap: 8, alignItems: "flex-start",
            background: "#fef9c3", border: "1px solid #fde68a",
            borderRadius: 6, padding: "10px 12px",
          }}>
            <span style={{ fontSize: 15, flexShrink: 0 }}>⚠</span>
            <span style={{ fontSize: 12, color: "#92400e", lineHeight: 1.55 }}>
              <strong>Your holdings are not sold automatically.</strong> You must manually exit all positions in your broker account after stopping the strategy.
            </span>
          </div>
        </div>
      ),
      btn: "Stop & Clear Dashboard", btnBg: "#dc2626",
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

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate();

  // ── Core state ──
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

  // ── Flash state for live-updated cards ──
  const [flashValue, setFlashValue] = useState(false);

  // ── Fetch portfolio on mount ──
  useEffect(() => {
    api.getPortfolio()
      .then(data => {
        setPortfolio(data);
        setLoading(false);
        setTimeout(() => setMounted(true), 40);
      })
      .catch(err => {
        if (err.message === "UNAUTHORIZED") {
          navigate("/login");
        } else {
          setError("Failed to load portfolio. Please refresh.");
          setLoading(false);
        }
      });
  }, []);

  // ── Fetch chart when panel opens or range changes ──
  useEffect(() => {
    if (view !== "chart") return;
    setChartLoading(true);
    api.getChartData(range)
      .then(data => { setChartData(data); setChartLoading(false); })
      .catch(err => {
        setChartLoading(false);
        if (err.message === "UNAUTHORIZED") navigate("/login");
        else setError(err.message || "Failed to load chart.");
      });
  }, [view, range]);

  // ── WebSocket: live holdings + summary updates ──
  const handleHoldingsUpdate = useCallback((items) => {
    // items = [{ symbol, ltp, ts }, ...]  — only changed symbols
    setPortfolio(prev => {
      if (!prev?.holdings) return prev;
      const updatedHoldings = prev.holdings.map(h => {
        const update = items.find(i => i.symbol === h.symbol);
        if (!update) return h;
        const ltp   = update.ltp;
        const value = ltp * h.qty;
        const pnl   = value - h.avgPrice * h.qty;
        const pnlPct = ((ltp - h.avgPrice) / h.avgPrice) * 100;
        return { ...h, ltp, value, pnl, pnlPct, priceSource: "live", priceTs: update.ts };
      });
      return { ...prev, holdings: updatedHoldings };
    });
  }, []);

  const handleSummaryUpdate = useCallback((summary) => {
    // summary = { currentValue, cash, equity }
    setPortfolio(prev => {
      if (!prev?.summary) return prev;
      const newCurrentValue = summary.currentValue ?? prev.summary.currentValue;
      const newCash         = summary.cash         ?? prev.summary.cash;
      const pnl             = newCurrentValue - prev.summary.invested;
      const pnlPct          = prev.summary.invested > 0
        ? (pnl / prev.summary.invested) * 100
        : prev.summary.pnlPct;
      return {
        ...prev,
        summary: {
          ...prev.summary,
          currentValue: newCurrentValue,
          cash:         newCash,
          pnl,
          pnlPct,
          priceSource: "live",
        },
      };
    });

    // Brief green flash on the value cards
    setFlashValue(true);
    setTimeout(() => setFlashValue(false), 700);
  }, []);

  const handleUnauthorized = useCallback(() => {
    navigate("/login");
  }, [navigate]);

  const wsEnabled = !!(portfolio?.strategyDeployed && portfolio?.strategy);

  const wsStatus = useLiveWebSocket({
    enabled: wsEnabled,
    onHoldingsUpdate: handleHoldingsUpdate,
    onSummaryUpdate:  handleSummaryUpdate,
    onUnauthorized:   handleUnauthorized,
  });

  // ── Toggle views ──
  const handleViewToggle = v => setView(prev => prev === v ? null : v);

  // ── Strategy actions ──
  async function handleConfirm() {
    const action = confirmAction;
    setConfirmAction(null);
    setActionLoading(true);

    try {
      await api.postAction(action);

      if (action === "stop") {
        setPortfolio(prev => ({
          ...prev,
          strategyDeployed: false,
          strategy: null,
          summary: { invested: 0, currentValue: 0, pnl: 0, pnlPct: 0, cash: 0 },
          holdings: [],
        }));
        setView(null);
      } else {
        setPortfolio(prev => ({
          ...prev,
          strategy: {
            ...prev.strategy,
            status: action === "pause" ? "paused" : "active",
          },
        }));
      }
    } catch (err) {
      if (err.message === "UNAUTHORIZED") navigate("/login");
      else setError("Action failed. Please try again.");
    } finally {
      setActionLoading(false);
    }
  }

  // ── Loading screen ──
  if (loading) return (
    <div style={{
      minHeight: "calc(100vh - 56px)", background: "#f2f2f2",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <Spinner size={34} />
    </div>
  );

  const { user, summary, holdings, strategyDeployed, strategy } = portfolio;
  const pnlPos = (summary?.pnl ?? 0) >= 0;

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

          {/* ── Error banner ── */}
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

          {/* ── Greeting + status badge ── */}
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
                {/* Live WebSocket indicator */}
                <WsStatusPill status={wsStatus} />
              </div>
            )}
          </div>

          {/* ── Strategy gate ── */}
          {!strategyDeployed ? (
            <NoStrategy onDeploy={() => navigate("/deploy")} />
          ) : (
            <>
              {strategy && (
                <StrategyPanel strategy={strategy} onAction={setConfirmAction} />
              )}

              {/* ── Summary stat cards ── */}
              {summary && (
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
                <button
                  className={`db-toggle ${view === "chart" ? "db-toggle-on" : "db-toggle-off"}`}
                  onClick={() => handleViewToggle("chart")}
                >
                  <span>▲</span> Portfolio Chart
                </button>
                <button
                  className={`db-toggle ${view === "holdings" ? "db-toggle-on" : "db-toggle-off"}`}
                  onClick={() => handleViewToggle("holdings")}
                >
                  <span>≡</span> Holdings
                </button>
              </div>

              {/* ── Chart panel ── */}
              {view === "chart" && (
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
                        {(holdings ?? []).map(h => {
                          const pos    = h.pnl >= 0;
                          const dayPos = h.dayChange >= 0;
                          return (
                            <tr key={h.symbol}>
                              <td>
                                <div className="db-sym">{h.symbol}</div>
                                <div className="db-sym-name">{h.name}</div>
                              </td>
                              <td>{h.qty}</td>
                              <td>{fmt(h.avgPrice)}</td>
                              {/* LTP gets a flash class when WS updates it */}
                              <td style={{ color: "#111", fontWeight: 600 }}
                                  key={`ltp-${h.symbol}-${h.priceTs}`}
                                  className={h.priceSource === "live" ? "ltp-flash" : ""}>
                                {fmt(h.ltp)}
                              </td>
                              <td>{fmtCompact(h.value)}</td>
                              <td>
                                <span className={pos ? "pos-text" : "neg-text"} style={{ fontWeight: 600 }}>
                                  {pos ? "+" : ""}{fmtCompact(h.pnl)}
                                </span>
                                <div className={`db-pnl-pct ${pos ? "pos-text" : "neg-text"}`}>
                                  {pos ? "▲" : "▼"} {Math.abs(h.pnlPct).toFixed(2)}%
                                </div>
                              </td>
                              <td className={dayPos ? "pos-text" : "neg-text"} style={{ fontWeight: 600 }}>
                                {dayPos ? "+" : ""}{h.dayChange.toFixed(2)}%
                              </td>
                            </tr>
                          );
                        })}
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