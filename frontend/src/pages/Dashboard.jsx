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
    // TODO: replace with real API call
    // const res = await fetch("/api/portfolio", { credentials: "include" });
    // if (!res.ok) throw new Error("Failed to fetch portfolio");
    // return res.json();
    // Expected shape: { user, summary, holdings, strategyDeployed }

    await new Promise(r => setTimeout(r, 900));
    return MOCK_PORTFOLIO;
  },

  getChartData: async (range) => {
    // TODO: replace with real API call
    // const res = await fetch(`/api/portfolio/history?range=${range}`, { credentials: "include" });
    // if (!res.ok) throw new Error("Failed to fetch chart data");
    // return res.json();
    // Expected shape: [{ date: string, value: number }]

    await new Promise(r => setTimeout(r, 450));
    return generateMockChart(range);
  },
};
// ─────────────────────────────────────────────────────────────────────────────

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
const MOCK_PORTFOLIO = {
  strategyDeployed: true, // toggle to false to preview "no strategy" state
  user: { name: "Your Name" },
  summary: {
    invested:     485000,
    currentValue: 531240,
    pnl:           46240,
    pnlPct:         9.53,
    cash:          68500,
  },
  holdings: [
    { symbol: "RELIANCE",    name: "Reliance Industries", qty: 120, avgPrice: 2410, ltp: 2587, value: 310440, pnl:  21240, pnlPct:  7.34, dayChange:  1.12 },
    { symbol: "TCS",         name: "Tata Consultancy",    qty:  45, avgPrice: 3780, ltp: 3921, value: 176445, pnl:   6345, pnlPct:  3.73, dayChange:  0.48 },
    { symbol: "INFY",        name: "Infosys Ltd",         qty:  80, avgPrice: 1620, ltp: 1574, value: 125920, pnl:  -3680, pnlPct: -2.84, dayChange: -0.92 },
    { symbol: "HDFCBANK",    name: "HDFC Bank",           qty:  60, avgPrice: 1540, ltp: 1612, value:  96720, pnl:   4320, pnlPct:  4.68, dayChange:  0.76 },
    { symbol: "BAJFINANCE",  name: "Bajaj Finance",       qty:  25, avgPrice: 6890, ltp: 6723, value: 168075, pnl:  -4175, pnlPct: -2.42, dayChange: -1.34 },
    { symbol: "NIFTY50",     name: "NIFTY 50 ETF",        qty: 200, avgPrice:  220, ltp:  241, value:  48200, pnl:   4200, pnlPct:  9.55, dayChange:  0.23 },
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
// ─────────────────────────────────────────────────────────────────────────────

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
// ─────────────────────────────────────────────────────────────────────────────

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────────

function Spinner({ size = 32 }) {
  return (
    <div style={{
      width: size, height: size,
      border: "2px solid rgba(0,229,160,0.12)",
      borderTopColor: "#00e5a0",
      borderRadius: "50%",
      animation: "dbSpin 0.75s linear infinite",
    }} />
  );
}

function NoStrategy({ onDeploy }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      minHeight: "48vh", textAlign: "center",
    }}>
      <div style={{
        width: 70, height: 70, borderRadius: "50%",
        border: "1px solid rgba(0,229,160,0.2)",
        background: "rgba(0,229,160,0.04)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 28, color: "rgba(0,229,160,0.45)",
        marginBottom: 24, position: "relative",
        boxShadow: "0 0 40px rgba(0,229,160,0.06)",
      }}>
        ◈
        <div style={{
          position: "absolute", inset: -7, borderRadius: "50%",
          border: "1px solid rgba(0,229,160,0.07)",
        }} />
      </div>

      <div style={{
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 10, letterSpacing: "0.2em",
        color: "rgba(0,229,160,0.5)",
        textTransform: "uppercase", marginBottom: 10,
      }}>
        // NO STRATEGY ACTIVE
      </div>

      <div style={{
        fontFamily: "'Syne',sans-serif",
        fontSize: 26, fontWeight: 700,
        color: "#fff", marginBottom: 10,
      }}>
        No Strategy Deployed
      </div>

      <div style={{
        width: 40, height: 1,
        background: "rgba(0,229,160,0.2)",
        margin: "0 auto 20px",
      }} />

      <div style={{
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 12, color: "rgba(255,255,255,0.32)",
        lineHeight: 1.8, maxWidth: 360, marginBottom: 32,
        letterSpacing: "0.03em",
      }}>
        Deploy a momentum strategy to activate live tracking, portfolio analytics, and holdings data.
      </div>

      <div style={{
        display: "flex", flexDirection: "column", gap: 10,
        width: "100%", maxWidth: 360, marginBottom: 32, textAlign: "left",
      }}>
        {[
          ["01", "Choose a momentum strategy from the library"],
          ["02", "Configure risk parameters and capital allocation"],
          ["03", "Deploy — dashboard activates automatically"],
        ].map(([num, text]) => (
          <div key={num} style={{
            display: "flex", alignItems: "flex-start", gap: 12,
            padding: "11px 14px",
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 8,
          }}>
            <span style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 10, color: "#00e5a0",
              background: "rgba(0,229,160,0.1)",
              borderRadius: 4, padding: "2px 7px",
              flexShrink: 0, marginTop: 1,
            }}>{num}</span>
            <span style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11, color: "rgba(255,255,255,0.38)",
              lineHeight: 1.6, letterSpacing: "0.03em",
            }}>{text}</span>
          </div>
        ))}
      </div>

      <button className="db-btn-primary" onClick={onDeploy}>
        Deploy Strategy
      </button>
    </div>
  );
}

function StatCard({ label, value, sub, subType, delay }) {
  return (
    <div className="db-stat" style={{ animationDelay: delay }}>
      <div className="db-stat-label">{label}</div>
      <div className={`db-stat-value ${subType || ""}`}>{value}</div>
      {sub && <span className={`db-stat-sub ${subType || ""}`}>{sub}</span>}
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "#0d1526",
      border: "1px solid rgba(0,229,160,0.2)",
      borderRadius: 8, padding: "10px 14px",
      fontFamily: "'JetBrains Mono',monospace", fontSize: 12,
    }}>
      <div style={{ color: "rgba(255,255,255,0.35)", marginBottom: 4, fontSize: 10 }}>{label}</div>
      <div style={{ color: "#00e5a0", fontWeight: 500 }}>{fmt(payload[0].value)}</div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();

  const [portfolio,    setPortfolio]    = useState(null);
  const [chartData,    setChartData]    = useState([]);
  const [view,         setView]         = useState(null);
  const [range,        setRange]        = useState("1M");
  const [loading,      setLoading]      = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [mounted,      setMounted]      = useState(false);

  useEffect(() => {
    dashboardService.getPortfolio()
      .then(data => {
        setPortfolio(data);
        setLoading(false);
        setTimeout(() => setMounted(true), 40);
      })
      .catch(err => {
        console.error("Portfolio fetch failed:", err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (view !== "chart") return;
    setChartLoading(true);
    dashboardService.getChartData(range)
      .then(data => { setChartData(data); setChartLoading(false); })
      .catch(()  => setChartLoading(false));
  }, [view, range]);

  const handleViewToggle = (v) => setView(prev => prev === v ? null : v);

  if (loading) return (
    <div style={{
      minHeight: "calc(100vh - 60px)", background: "#060a12",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <Spinner size={36} />
    </div>
  );

  const { user, summary, holdings, strategyDeployed } = portfolio;
  const pnlPos = summary.pnl >= 0;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .db-root {
          min-height: calc(100vh - 60px);
          background: #060a12;
          padding: 36px 40px 80px;
          font-family: 'Syne', sans-serif;
          position: relative;
        }
        .db-root::before {
          content: '';
          position: fixed; inset: 0; pointer-events: none;
          background-image:
            linear-gradient(rgba(0,229,160,0.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,229,160,0.025) 1px, transparent 1px);
          background-size: 40px 40px;
        }

        .db-wrap {
          max-width: 1100px; margin: 0 auto;
          opacity: 0; transform: translateY(16px);
          transition: opacity 0.5s ease, transform 0.5s cubic-bezier(0.16,1,0.3,1);
        }
        .db-wrap.mounted { opacity: 1; transform: translateY(0); }

        .db-greeting-sub {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; letter-spacing: 0.2em;
          color: rgba(0,229,160,0.55); text-transform: uppercase;
          margin-bottom: 6px;
        }
        .db-greeting-name {
          font-size: 30px; font-weight: 800;
          color: #fff; letter-spacing: 0.01em; margin-bottom: 32px;
        }
        .db-greeting-name span { color: #00e5a0; }

        .db-summary {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 14px; margin-bottom: 28px;
        }
        @media (max-width: 860px) {
          .db-summary { grid-template-columns: repeat(2, 1fr); }
          .db-root { padding: 24px 20px 60px; }
        }
        @media (max-width: 480px) { .db-summary { grid-template-columns: 1fr; } }

        .db-stat {
          background: rgba(10,16,30,0.85);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px; padding: 20px 22px;
          position: relative; overflow: hidden;
          transition: border-color 0.2s, transform 0.2s;
          opacity: 0; transform: translateY(10px);
          animation: statIn 0.4s ease forwards;
        }
        .db-stat:hover { border-color: rgba(0,229,160,0.18); transform: translateY(-1px); }
        .db-stat::before {
          content: '';
          position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, rgba(0,229,160,0.25), transparent);
        }
        @keyframes statIn { to { opacity: 1; transform: translateY(0); } }

        .db-stat-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
          color: rgba(255,255,255,0.28); margin-bottom: 10px;
        }
        .db-stat-value {
          font-size: 22px; font-weight: 700;
          color: #fff; letter-spacing: -0.01em; margin-bottom: 5px;
        }
        .db-stat-value.pos { color: #00e5a0; }
        .db-stat-value.neg { color: #ff4d6d; }
        .db-stat-sub {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; color: rgba(255,255,255,0.22);
        }
        .db-stat-sub.pos { background: rgba(0,229,160,0.1); color: #00e5a0; padding: 2px 8px; border-radius: 4px; }
        .db-stat-sub.neg { background: rgba(255,77,109,0.1); color: #ff4d6d; padding: 2px 8px; border-radius: 4px; }

        .db-toggles { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
        .db-toggle {
          font-family: 'Syne', sans-serif;
          font-size: 12px; font-weight: 700;
          letter-spacing: 0.08em; text-transform: uppercase;
          padding: 9px 22px; border-radius: 8px; border: none; cursor: pointer;
          display: flex; align-items: center; gap: 8px;
          transition: all 0.18s;
        }
        .db-toggle-off {
          background: rgba(255,255,255,0.04);
          color: rgba(255,255,255,0.4);
          border: 1px solid rgba(255,255,255,0.08);
        }
        .db-toggle-off:hover { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.65); }
        .db-toggle-on {
          background: linear-gradient(135deg, #00e5a0, #00c98c);
          color: #060a12;
          box-shadow: 0 4px 16px rgba(0,229,160,0.22);
        }

        .db-panel {
          background: rgba(10,16,30,0.88);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 14px; overflow: hidden;
          animation: panelIn 0.35s cubic-bezier(0.16,1,0.3,1) both;
        }
        @keyframes panelIn {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .db-panel-header {
          padding: 16px 24px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          display: flex; align-items: center; justify-content: space-between;
        }
        .db-panel-title {
          font-size: 12px; font-weight: 700;
          letter-spacing: 0.1em; text-transform: uppercase;
          color: rgba(255,255,255,0.55);
        }

        .db-ranges { display: flex; gap: 4px; }
        .db-range {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px; padding: 4px 10px;
          border-radius: 6px; border: none; cursor: pointer;
          transition: all 0.15s;
        }
        .db-range-on  { background: rgba(0,229,160,0.14); color: #00e5a0; }
        .db-range-off { background: transparent; color: rgba(255,255,255,0.28); }
        .db-range-off:hover { color: rgba(255,255,255,0.6); }

        .db-chart-body { padding: 24px 12px 16px; }
        .db-chart-loading {
          height: 260px; display: flex;
          align-items: center; justify-content: center;
        }

        .db-table { width: 100%; border-collapse: collapse; }
        .db-table thead th {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
          color: rgba(255,255,255,0.22);
          padding: 13px 20px; font-weight: 400; text-align: right;
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .db-table thead th:first-child { text-align: left; }
        .db-table tbody tr {
          border-bottom: 1px solid rgba(255,255,255,0.04);
          transition: background 0.15s;
        }
        .db-table tbody tr:last-child { border-bottom: none; }
        .db-table tbody tr:hover { background: rgba(255,255,255,0.025); }
        .db-table td {
          padding: 13px 20px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px; color: rgba(255,255,255,0.7);
          text-align: right; vertical-align: middle;
        }
        .db-table td:first-child { text-align: left; }

        .db-sym      { font-weight: 500; color: #fff; font-size: 13px; letter-spacing: 0.04em; }
        .db-sym-name { font-size: 10px; color: rgba(255,255,255,0.28); margin-top: 3px; }
        .db-pnl-pct  { font-size: 10px; margin-top: 2px; }
        .pos-text    { color: #00e5a0; }
        .neg-text    { color: #ff4d6d; }

        .db-btn-primary {
          font-family: 'Syne', sans-serif;
          font-size: 12px; font-weight: 700;
          letter-spacing: 0.1em; text-transform: uppercase;
          padding: 11px 28px; border-radius: 8px;
          border: none; cursor: pointer;
          background: linear-gradient(135deg, #00e5a0, #00c98c);
          color: #060a12;
          box-shadow: 0 4px 20px rgba(0,229,160,0.22);
          transition: opacity 0.15s, transform 0.15s;
        }
        .db-btn-primary:hover  { opacity: 0.86; transform: translateY(-1px); }
        .db-btn-primary:active { transform: translateY(0); }

        @keyframes dbSpin { to { transform: rotate(360deg); } }
      `}</style>

      <div className="db-root">
        <div className={`db-wrap ${mounted ? "mounted" : ""}`}>

          {/* ── Greeting ─────────────────────────────────────── */}
          <div className="db-greeting-sub">// Welcome back</div>
          <div className="db-greeting-name">
            {user.name.split(" ")[0]}{" "}
            <span>{user.name.split(" ").slice(1).join(" ")}</span>
          </div>

          {/* ── Strategy Gate ────────────────────────────────── */}
          {!strategyDeployed ? (
            <NoStrategy onDeploy={() => navigate("/deploy")} />
          ) : (
            <>
              {/* ── Summary Cards ──────────────────────────────── */}
              <div className="db-summary">
                <StatCard
                  label="Invested"
                  value={fmtCompact(summary.invested)}
                  sub={fmt(summary.invested)}
                  delay="0.05s"
                />
                <StatCard
                  label="Current Value"
                  value={fmtCompact(summary.currentValue)}
                  sub={fmt(summary.currentValue)}
                  delay="0.1s"
                />
                <StatCard
                  label="P&L"
                  value={(pnlPos ? "+" : "") + fmtCompact(summary.pnl)}
                  sub={(pnlPos ? "▲ " : "▼ ") + Math.abs(summary.pnlPct).toFixed(2) + "%"}
                  subType={pnlPos ? "pos" : "neg"}
                  delay="0.15s"
                />
                <StatCard
                  label="Cash Available"
                  value={fmtCompact(summary.cash)}
                  sub={fmt(summary.cash)}
                  delay="0.2s"
                />
              </div>

              {/* ── Toggle Buttons ─────────────────────────────── */}
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

              {/* ── Chart Panel ────────────────────────────────── */}
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
                  <div className="db-chart-body">
                    {chartLoading ? (
                      <div className="db-chart-loading"><Spinner size={30} /></div>
                    ) : (
                      <ResponsiveContainer width="100%" height={280}>
                        <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                          <defs>
                            <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%"   stopColor="#00e5a0" stopOpacity={0.18} />
                              <stop offset="100%" stopColor="#00e5a0" stopOpacity={0}    />
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                          <XAxis
                            dataKey="date"
                            tick={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fill: "rgba(255,255,255,0.22)" }}
                            tickLine={false} axisLine={false} interval="preserveStartEnd"
                          />
                          <YAxis
                            tick={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fill: "rgba(255,255,255,0.22)" }}
                            tickLine={false} axisLine={false}
                            tickFormatter={v => "₹" + (v / 100000).toFixed(1) + "L"}
                            width={62}
                          />
                          <Tooltip content={<ChartTooltip />} />
                          <Area
                            type="monotone" dataKey="value"
                            stroke="#00e5a0" strokeWidth={2}
                            fill="url(#chartGrad)" dot={false}
                            activeDot={{ r: 4, fill: "#00e5a0", stroke: "#060a12", strokeWidth: 2 }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
              )}

              {/* ── Holdings Panel ─────────────────────────────── */}
              {view === "holdings" && (
                <div className="db-panel">
                  <div className="db-panel-header">
                    <span className="db-panel-title">Current Holdings</span>
                    <span style={{
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: 10, color: "rgba(255,255,255,0.22)",
                    }}>
                      {holdings.length} positions
                    </span>
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
                              <td style={{ color: "#fff" }}>{fmt(h.ltp)}</td>
                              <td>{fmtCompact(h.value)}</td>
                              <td>
                                <span className={pos ? "pos-text" : "neg-text"}>
                                  {pos ? "+" : ""}{fmtCompact(h.pnl)}
                                </span>
                                <div className={`db-pnl-pct ${pos ? "pos-text" : "neg-text"}`}>
                                  {pos ? "▲" : "▼"} {Math.abs(h.pnlPct).toFixed(2)}%
                                </div>
                              </td>
                              <td className={dayPos ? "pos-text" : "neg-text"}>
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