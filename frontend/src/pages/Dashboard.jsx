import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid
} from "recharts";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// ─── API SERVICE LAYER ────────────────────────────────────────────────────────
const dashboardService = {
  getPortfolio: async () => {
    await new Promise(r => setTimeout(r, 900));
    return MOCK_PORTFOLIO;
  },
  getChartData: async (range) => {
    await new Promise(r => setTimeout(r, 450));
    return generateMockChart(range);
  },
  postAction: async (action) => {
    await new Promise(r => setTimeout(r, 400));
    return { success: true, status: action === "pause" ? "paused" : action === "stop" ? "stopped" : "active" };
  },
};

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
const MOCK_PORTFOLIO = {
  strategyDeployed: true,
  user: { name: "Your Name" },
  strategy: {
    status: "active",
    universe: "Nifty 50",
    numStocks: 10,
    priceCap: null,
    lookback1: 6,
    lookback2: 12,
    capital: 500000,
    rebalanceType: "monthly",
    frequency: 1,
    startingDate: "2024-01-15",
    lastRebalanced: "2025-02-01",
    nextRebalance: "2025-03-01",
  },
  summary: {
    invested:     485000,
    currentValue: 531240,
    pnl:           46240,
    pnlPct:         9.53,
    cash:          68500,
  },
  holdings: [
    { symbol: "RELIANCE",   name: "Reliance Industries", qty: 120, avgPrice: 2410, ltp: 2587, value: 310440, pnl:  21240, pnlPct:  7.34, dayChange:  1.12 },
    { symbol: "TCS",        name: "Tata Consultancy",    qty:  45, avgPrice: 3780, ltp: 3921, value: 176445, pnl:   6345, pnlPct:  3.73, dayChange:  0.48 },
    { symbol: "INFY",       name: "Infosys Ltd",         qty:  80, avgPrice: 1620, ltp: 1574, value: 125920, pnl:  -3680, pnlPct: -2.84, dayChange: -0.92 },
    { symbol: "HDFCBANK",   name: "HDFC Bank",           qty:  60, avgPrice: 1540, ltp: 1612, value:  96720, pnl:   4320, pnlPct:  4.68, dayChange:  0.76 },
    { symbol: "BAJFINANCE", name: "Bajaj Finance",       qty:  25, avgPrice: 6890, ltp: 6723, value: 168075, pnl:  -4175, pnlPct: -2.42, dayChange: -1.34 },
    { symbol: "NIFTY50",    name: "NIFTY 50 ETF",        qty: 200, avgPrice:  220, ltp:  241, value:  48200, pnl:   4200, pnlPct:  9.55, dayChange:  0.23 },
  ],
};

function generateMockChart(range) {
  const points = { "1W": 7, "1M": 30, "3M": 90, "1Y": 52 }[range] || 30;
  const data = [];
  let val = 480000;
  const now = new Date();
  for (let i = points; i >= 0; i--) {
    const d = new Date(now);
    range === "1Y" ? d.setDate(d.getDate() - i * 7) : d.setDate(d.getDate() - i);
    val = Math.max(420000, val + (Math.random() - 0.42) * 9000);
    data.push({
      date: d.toLocaleDateString("en-IN", { month: "short", day: "numeric" }),
      value: Math.round(val),
    });
  }
  return data;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmt = (n) => "₹" + Number(n).toLocaleString("en-IN");
const fmtCompact = (n) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 10000000) return sign + "₹" + (abs / 10000000).toFixed(2) + "Cr";
  if (abs >= 100000)   return sign + "₹" + (abs / 100000).toFixed(2) + "L";
  if (abs >= 1000)     return sign + "₹" + (abs / 1000).toFixed(1) + "K";
  return sign + "₹" + abs;
};

const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

// ─── STATUS CONFIG ────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  active:  { label: "Active",  bg: "#dcfce7", color: "#15803d", dot: "#22c55e", ring: "#bbf7d0" },
  paused:  { label: "Paused",  bg: "#fef9c3", color: "#a16207", dot: "#eab308", ring: "#fef08a" },
  stopped: { label: "Stopped", bg: "#fee2e2", color: "#b91c1c", dot: "#ef4444", ring: "#fecaca" },
};

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.stopped;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 10px", borderRadius: 20,
      background: cfg.bg, border: `1px solid ${cfg.ring}`,
      fontSize: 11, fontWeight: 700, color: cfg.color,
      fontFamily: SYS, letterSpacing: "0.03em",
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: cfg.dot,
        display: "inline-block",
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
      btn: "Stop & Clear Dashboard",
      btnBg: "#dc2626",
    },
    pause: {
      title: "Pause Strategy",
      desc: "Rebalancing will be paused. Current holdings remain unchanged and no new trades will be placed until resumed.",
      btn: "Pause Strategy",
      btnBg: "#d97706",
    },
    resume: {
      title: "Resume Strategy",
      desc: "Strategy will resume rebalancing on the next scheduled date. No immediate trades will be placed.",
      btn: "Resume Strategy",
      btnBg: "#16a34a",
    },
    restart: {
      title: "Restart Strategy",
      desc: "Strategy will be restarted from today using your existing configuration. Rebalancing will resume on the next scheduled date.",
      btn: "Restart Strategy",
      btnBg: "#111",
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
            : cfg.desc
          }
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
            style={{ flex: 1, padding: "10px", borderRadius: 6, border: "1px solid #ccc", background: "#fff", fontSize: 13, fontWeight: 600, color: "#444", cursor: "pointer", fontFamily: SYS }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{ flex: 2, padding: "10px", borderRadius: 6, border: "none", background: cfg.btnBg, fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: SYS }}
          >
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
              width: 20, height: 20, borderRadius: 5,
              background: "#222", color: "#fff",
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
          cursor: "pointer", fontFamily: SYS, transition: "background 0.14s",
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
function StatCard({ label, value, sub, pnlType, delay }) {
  const isPos = pnlType === "pos";
  const isNeg = pnlType === "neg";
  return (
    <div style={{
      background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8,
      padding: "18px 20px",
      opacity: 0, transform: "translateY(8px)",
      animation: `statIn 0.35s ease ${delay} forwards`,
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10, fontFamily: SYS }}>{label}</div>
      <div style={{
        fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 6, fontFamily: MONO,
        color: isPos ? "#1b6f3e" : isNeg ? "#c62828" : "#111",
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
      {/* Header */}
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
            <ActionBtn
              label={isStopped ? "Restart" : "Resume"}
              icon="▶"
              onClick={() => onAction(isStopped ? "restart" : "resume")}
              bg="#111" color="#fff"
            />
          )}
          {isActive && (
            <ActionBtn
              label="Pause"
              icon="⏸"
              onClick={() => onAction("pause")}
              bg="#fff" color="#555" border="1px solid #ccc"
            />
          )}
          {!isStopped && (
            <ActionBtn
              label="Stop"
              icon="■"
              onClick={() => onAction("stop")}
              bg="#fff" color="#c62828" border="1px solid #fca5a5"
            />
          )}
        </div>
      </div>

      {/* Metrics grid */}
      <div style={{ padding: "4px 8px 8px" }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
        }}>
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

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
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

  useEffect(() => {
    dashboardService.getPortfolio()
      .then(data => {
        setPortfolio(data);
        setLoading(false);
        setTimeout(() => setMounted(true), 40);
      })
      .catch(err => { console.error("Portfolio fetch failed:", err); setLoading(false); });
  }, []);

  useEffect(() => {
    if (view !== "chart") return;
    setChartLoading(true);
    dashboardService.getChartData(range)
      .then(data => { setChartData(data); setChartLoading(false); })
      .catch(() => setChartLoading(false));
  }, [view, range]);

  const handleViewToggle = v => setView(prev => prev === v ? null : v);

  async function handleConfirm() {
    const action = confirmAction;
    setConfirmAction(null);
    setActionLoading(true);

    try {
      await dashboardService.postAction(action);

      if (action === "stop") {
        // Wipe all data — show NoStrategy screen
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
      console.error("Action failed:", err);
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
  const pnlPos = summary.pnl >= 0;

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .db-root {
          padding: 28px 28px 72px;
          font-family: ${SYS};
        }
        .db-wrap {
          max-width: 1100px; margin: 0 auto;
          opacity: 0; transform: translateY(10px);
          transition: opacity 0.35s ease, transform 0.35s ease;
        }
        .db-wrap.mounted { opacity: 1; transform: translateY(0); }

        /* Summary cards grid */
        .db-summary {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 12px; margin-bottom: 24px;
        }
        @media (max-width: 860px) {
          .db-summary { grid-template-columns: repeat(2, 1fr); }
          .db-root { padding: 18px 14px 60px; }
        }
        @media (max-width: 480px) {
          .db-summary { grid-template-columns: 1fr; }
        }

        @keyframes statIn  { to { opacity: 1; transform: translateY(0); } }
        @keyframes panelIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes dbSpin  { to { transform: rotate(360deg); } }
        @keyframes pulse   { 0%,100% { box-shadow: 0 0 0 2px #bbf7d0; } 50% { box-shadow: 0 0 0 4px #dcfce7; } }

        /* Toggle buttons */
        .db-toggles { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
        .db-toggle {
          font-size: 12px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
          padding: 8px 18px; border-radius: 6px; border: none; cursor: pointer;
          display: flex; align-items: center; gap: 7px; transition: all 0.14s;
          font-family: ${SYS};
        }
        .db-toggle-off { background: #fff; color: #555; border: 1px solid #ccc; }
        .db-toggle-off:hover { background: #f5f5f5; border-color: #999; }
        .db-toggle-on  { background: #222; color: #fff; }

        /* Panel */
        .db-panel {
          background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;
          animation: panelIn 0.3s ease both;
        }
        .db-panel-header {
          padding: 13px 20px; border-bottom: 1px solid #ebebeb; background: #f8f8f8;
          display: flex; align-items: center; justify-content: space-between;
        }
        .db-panel-title { font-size: 12px; font-weight: 700; color: #333; text-transform: uppercase; letter-spacing: 0.05em; }

        /* Range buttons */
        .db-ranges { display: flex; gap: 3px; }
        .db-range {
          font-family: ${MONO}; font-size: 11px;
          padding: 4px 10px; border-radius: 5px; border: none; cursor: pointer; transition: all 0.13s;
        }
        .db-range-on  { background: #222; color: #fff; }
        .db-range-off { background: transparent; color: #888; }
        .db-range-off:hover { background: #f0f0f0; color: #333; }

        /* Holdings table */
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
        .db-table td {
          padding: 11px 18px; font-family: ${MONO}; font-size: 13px;
          color: #333; text-align: right; vertical-align: middle;
        }
        .db-table td:first-child { text-align: left; }
        .db-sym      { font-weight: 700; color: #111; font-size: 13px; }
        .db-sym-name { font-size: 10px; color: #999; margin-top: 2px; }
        .db-pnl-pct  { font-size: 10px; margin-top: 2px; }
        .pos-text { color: #1b6f3e; }
        .neg-text { color: #c62828; }
      `}</style>

      {/* Confirm modal */}
      {confirmAction && (
        <ConfirmModal
          action={confirmAction}
          onConfirm={handleConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* Action loading overlay */}
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
              <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 6 }}>
                <span style={{ fontSize: 11, color: "#999", fontFamily: SYS }}>Strategy</span>
                <StatusBadge status={strategy.status} />
              </div>
            )}
          </div>

          {/* ── Strategy gate ── */}
          {!strategyDeployed ? (
            <NoStrategy onDeploy={() => navigate("/deploy")} />
          ) : (
            <>
              {/* ── Strategy panel ── */}
              {strategy && (
                <StrategyPanel strategy={strategy} onAction={setConfirmAction} />
              )}

              {/* ── Summary stat cards ── */}
              <div className="db-summary">
                <StatCard label="Invested"       value={fmtCompact(summary.invested)}     sub={fmt(summary.invested)}                                                                    delay="0.04s" />
                <StatCard label="Current Value"  value={fmtCompact(summary.currentValue)} sub={fmt(summary.currentValue)}                                                                delay="0.09s" />
                <StatCard label="P&L"            value={(pnlPos ? "+" : "") + fmtCompact(summary.pnl)} sub={(pnlPos ? "▲ " : "▼ ") + Math.abs(summary.pnlPct).toFixed(2) + "%"} pnlType={pnlPos ? "pos" : "neg"} delay="0.14s" />
                <StatCard label="Cash Available" value={fmtCompact(summary.cash)}         sub={fmt(summary.cash)}                                                                        delay="0.19s" />
              </div>

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
                <div className="db-panel">
                  <div className="db-panel-header">
                    <span className="db-panel-title">Portfolio Value</span>
                    <div className="db-ranges">
                      {["1W","1M","3M","1Y"].map(r => (
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
                    <span style={{ fontSize: 11, color: "#999", fontFamily: MONO }}>{holdings.length} positions</span>
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
                        {holdings.map(h => {
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
                              <td style={{ color: "#111", fontWeight: 600 }}>{fmt(h.ltp)}</td>
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