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
    await new Promise(r => setTimeout(r, 900));
    return MOCK_PORTFOLIO;
  },
  getChartData: async (range) => {
    // TODO: replace with real API call
    await new Promise(r => setTimeout(r, 450));
    return generateMockChart(range);
  },
};

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
const MOCK_PORTFOLIO = {
  strategyDeployed: true,
  user: { name: "Your Name" },
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

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────────

function Spinner({ size = 32 }) {
  return (
    <div style={{
      width: size, height: size,
      border: "2.5px solid #e8e8e8",
      borderTopColor: "#333",
      borderRadius: "50%",
      animation: "dbSpin 0.7s linear infinite",
    }} />
  );
}

function NoStrategy({ onDeploy }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      minHeight: "46vh", textAlign: "center",
      padding: "40px 20px",
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: "50%",
        border: "1.5px solid #e0e0e0",
        background: "#f5f5f5",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 24, color: "#999",
        marginBottom: 20,
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
            padding: "10px 14px",
            background: "#fff", border: "1px solid #e8e8e8", borderRadius: 7,
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
          cursor: "pointer", fontFamily: SYS,
          transition: "background 0.14s",
        }}
        onMouseEnter={e => e.target.style.background = "#3a3a3a"}
        onMouseLeave={e => e.target.style.background = "#222"}
      >
        Deploy Strategy
      </button>
    </div>
  );
}

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
        pnlType ? (
          <span style={{
            display: "inline-block",
            fontSize: 11, fontWeight: 600, fontFamily: MONO,
            padding: "2px 8px", borderRadius: 4,
            background: isPos ? "#ebf7ef" : "#fdecea",
            color: isPos ? "#1b6f3e" : "#c62828",
          }}>{sub}</span>
        ) : (
          <span style={{ fontSize: 11, color: "#999", fontFamily: MONO }}>{sub}</span>
        )
      )}
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "#fff", border: "1px solid #e0e0e0",
      borderRadius: 7, padding: "9px 13px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.09)",
      fontFamily: SYS,
    }}>
      <div style={{ fontSize: 10, color: "#888", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#111", fontFamily: MONO }}>{fmt(payload[0].value)}</div>
    </div>
  );
}

// ─── MAIN DASHBOARD ──────────────────────────────────────────────────────────
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

  if (loading) return (
    <div style={{
      minHeight: "calc(100vh - 56px)", background: "#f2f2f2",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <Spinner size={34} />
    </div>
  );

  const { user, summary, holdings, strategyDeployed } = portfolio;
  const pnlPos = summary.pnl >= 0;

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .db-root {
          min-height: calc(100vh - 56px);
          background: #f2f2f2;
          padding: 28px 28px 72px;
          font-family: ${SYS};
        }
        .db-wrap {
          max-width: 1100px; margin: 0 auto;
          opacity: 0; transform: translateY(10px);
          transition: opacity 0.35s ease, transform 0.35s ease;
        }
        .db-wrap.mounted { opacity: 1; transform: translateY(0); }

        /* Summary grid */
        .db-summary {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 12px; margin-bottom: 24px;
        }
        @media (max-width: 860px) { .db-summary { grid-template-columns: repeat(2, 1fr); } .db-root { padding: 18px 14px 60px; } }
        @media (max-width: 480px) { .db-summary { grid-template-columns: 1fr; } }

        @keyframes statIn  { to { opacity: 1; transform: translateY(0); } }
        @keyframes panelIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes dbSpin  { to { transform: rotate(360deg); } }

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

        /* Table */
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

      <div className="db-root">
        <div className={`db-wrap ${mounted ? "mounted" : ""}`}>

          {/* ── Greeting ──────────────────────────────────────── */}
          <div style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>
              Welcome back
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#111" }}>
              {user.name}
            </div>
          </div>

          {/* ── Strategy Gate ─────────────────────────────────── */}
          {!strategyDeployed ? (
            <NoStrategy onDeploy={() => navigate("/deploy")} />
          ) : (
            <>
              {/* ── Summary Cards ─────────────────────────────── */}
              <div className="db-summary">
                <StatCard label="Invested"      value={fmtCompact(summary.invested)}     sub={fmt(summary.invested)}                                     delay="0.04s" />
                <StatCard label="Current Value" value={fmtCompact(summary.currentValue)} sub={fmt(summary.currentValue)}                                 delay="0.09s" />
                <StatCard label="P&L"           value={(pnlPos ? "+" : "") + fmtCompact(summary.pnl)} sub={(pnlPos ? "▲ " : "▼ ") + Math.abs(summary.pnlPct).toFixed(2) + "%"} pnlType={pnlPos ? "pos" : "neg"} delay="0.14s" />
                <StatCard label="Cash Available" value={fmtCompact(summary.cash)}        sub={fmt(summary.cash)}                                         delay="0.19s" />
              </div>

              {/* ── Toggle Buttons ────────────────────────────── */}
              <div className="db-toggles">
                <button className={`db-toggle ${view === "chart" ? "db-toggle-on" : "db-toggle-off"}`} onClick={() => handleViewToggle("chart")}>
                  <span>▲</span> Portfolio Chart
                </button>
                <button className={`db-toggle ${view === "holdings" ? "db-toggle-on" : "db-toggle-off"}`} onClick={() => handleViewToggle("holdings")}>
                  <span>≡</span> Holdings
                </button>
              </div>

              {/* ── Chart Panel ───────────────────────────────── */}
              {view === "chart" && (
                <div className="db-panel">
                  <div className="db-panel-header">
                    <span className="db-panel-title">Portfolio Value</span>
                    <div className="db-ranges">
                      {["1W","1M","3M","1Y"].map(r => (
                        <button key={r} className={`db-range ${range === r ? "db-range-on" : "db-range-off"}`} onClick={() => setRange(r)}>{r}</button>
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
                              <stop offset="100%" stopColor="#3b5bdb" stopOpacity={0}    />
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

              {/* ── Holdings Panel ────────────────────────────── */}
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