import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart, Area, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─── API ──────────────────────────────────────────────────────────────────────
const BASE_URL = import.meta.env.VITE_API_BASE_URL;

// Helper: POST JSON to a URL, throw on error
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || res.statusText);
  return data;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TODAY    = new Date().toISOString().split("T")[0];
const MIN_DATE = "2003-01-01";

const UNIVERSES = [
  { value: "nifty50",  label: "Nifty 50",  desc: "Large cap · 50 stocks"    },
  { value: "nifty100", label: "Nifty 100", desc: "Large cap · 100 stocks"   },
  { value: "nifty150", label: "Nifty 150", desc: "Large + Mid · 150 stocks" },
  { value: "nifty250", label: "Nifty 250", desc: "Large + Mid · 250 stocks" },
];

// Arrays [1..12] and [1..52] for dropdowns
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const WEEKS  = Array.from({ length: 52 }, (_, i) => i + 1);

const DEFAULT_FORM = {
  universe: "nifty50",
  numStocks: 10,
  lookback1: 6,
  lookback2: 12,
  priceCap: "",
  capital: "",
  rebalanceType: "monthly",
  rebalanceFreq: 1,
  startingDate: TODAY,
};

// ─── VALIDATION ───────────────────────────────────────────────────────────────
function validateForm(form) {
  const errors = {};
  if (!form.universe)                                errors.universe  = "Select a universe";
  if (!form.numStocks || form.numStocks < 1)         errors.numStocks = "Minimum 1 stock required";
  if (form.lookback1 === form.lookback2)             errors.lookback2 = "Must differ from Period 1";
  if (!form.capital || Number(form.capital) < 10000) errors.capital   = "Minimum ₹10,000 required";
  return errors;
}

// ─── FORMATTERS ───────────────────────────────────────────────────────────────
const fmtPct   = v => `${(v * 100).toFixed(2)}%`;
const fmtNum   = (v, d = 2) => Number(v).toFixed(d);
const fmtRupee = v => `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

// ─── FONTS ────────────────────────────────────────────────────────────────────
const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

// ─── SMALL REUSABLE COMPONENTS ────────────────────────────────────────────────

// Field label with optional hint
function Label({ children, hint }) {
  return (
    <div style={{ marginBottom: 6, display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#111", fontFamily: SYS }}>{children}</span>
      {hint && <span style={{ fontSize: 11, color: "#777", fontFamily: SYS }}>{hint}</span>}
    </div>
  );
}

// Red error text below a field
function FieldError({ msg }) {
  if (!msg) return null;
  return <div style={{ fontSize: 11, color: "#c62828", marginTop: 4, fontWeight: 500, fontFamily: SYS }}>⚠ {msg}</div>;
}

// Number input with optional ₹ prefix or "stocks" suffix
function NumberInput({ value, onChange, placeholder, prefix, suffix, error }) {
  const [focused, setFocused] = useState(false);
  const borderColor = error ? "#c62828" : focused ? "#333" : "#ccc";

  return (
    <div style={{ display: "flex", alignItems: "center", border: `1.5px solid ${borderColor}`, borderRadius: 6, background: "#fff", boxShadow: focused ? "0 0 0 3px rgba(0,0,0,0.07)" : "none", transition: "border-color 0.14s" }}>
      {prefix && <span style={{ fontSize: 13, color: "#555", paddingLeft: 11, fontFamily: SYS, userSelect: "none" }}>{prefix}</span>}
      <input
        type="number"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 14, color: "#111", padding: prefix ? "9px 11px 9px 5px" : "9px 11px", fontFamily: SYS }}
      />
      {suffix && <span style={{ fontSize: 11, color: "#777", paddingRight: 11, fontFamily: SYS, userSelect: "none" }}>{suffix}</span>}
    </div>
  );
}

// Dropdown select
function Dropdown({ value, onChange, options, error }) {
  const [focused, setFocused] = useState(false);
  const borderColor = error ? "#c62828" : focused ? "#333" : "#ccc";

  return (
    <div style={{ border: `1.5px solid ${borderColor}`, borderRadius: 6, background: "#fff", position: "relative", boxShadow: focused ? "0 0 0 3px rgba(0,0,0,0.07)" : "none", transition: "border-color 0.14s" }}>
      <select
        value={value}
        onChange={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: 13, color: "#111", padding: "9px 32px 9px 11px", appearance: "none", cursor: "pointer", fontFamily: SYS }}
      >
        {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
      </select>
      <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "#888", fontSize: 10, pointerEvents: "none" }}>▼</span>
    </div>
  );
}

// Numbered section card
function Section({ number, title, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "11px 18px", borderBottom: "1px solid #ebebeb", display: "flex", alignItems: "center", gap: 10, background: "#f8f8f8" }}>
        <span style={{ width: 22, height: 22, borderRadius: 5, background: "#222", color: "#fff", fontSize: 11, fontWeight: 700, fontFamily: SYS, display: "flex", alignItems: "center", justifyContent: "center" }}>{number}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#111", textTransform: "uppercase", letterSpacing: "0.02em", fontFamily: SYS }}>{title}</span>
      </div>
      <div style={{ padding: "16px 18px" }}>{children}</div>
    </div>
  );
}

// Blue info hint box
function Hint({ children }) {
  return (
    <div style={{ display: "flex", gap: 7, background: "#eef2ff", border: "1px solid #c5d0f0", borderRadius: 6, padding: "9px 11px", marginTop: 10, fontSize: 12, color: "#333", lineHeight: 1.5 }}>
      <span style={{ color: "#3b5bdb", flexShrink: 0 }}>ℹ</span>
      <span>{children}</span>
    </div>
  );
}

// Red error banner (shown when API call fails)
function ErrorBanner({ message, onDismiss }) {
  return (
    <div style={{ background: "#fff5f5", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", marginTop: 16, display: "flex", justifyContent: "space-between", gap: 12, fontFamily: SYS }}>
      <div style={{ display: "flex", gap: 8 }}>
        <span style={{ color: "#c62828" }}>✕</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#c62828", marginBottom: 2 }}>Backtest Failed</div>
          <div style={{ fontSize: 12, color: "#7f1d1d", lineHeight: 1.5 }}>{message}</div>
        </div>
      </div>
      <button onClick={onDismiss} style={{ background: "none", border: "none", cursor: "pointer", color: "#c62828", fontSize: 18 }}>×</button>
    </div>
  );
}

// Animated loading dots (shown inside buttons while loading)
function LoadingDots() {
  return <div className="dots"><span /><span /><span /></div>;
}

// ─── BACKTEST DATE MODAL ──────────────────────────────────────────────────────
function BacktestDateModal({ onConfirm, onCancel }) {
  const [date, setDate] = useState("2015-01-01");

  const isValid = date && date >= MIN_DATE && date < TODAY;
  const years   = isValid ? ((new Date() - new Date(date)) / (365.25 * 86400000)).toFixed(1) : 0;

  const presets = [
    { label: "1 Year",     date: new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString().split("T")[0] },
    { label: "3 Years",    date: new Date(new Date().setFullYear(new Date().getFullYear() - 3)).toISOString().split("T")[0] },
    { label: "5 Years",    date: new Date(new Date().setFullYear(new Date().getFullYear() - 5)).toISOString().split("T")[0] },
    { label: "10 Years",   date: new Date(new Date().setFullYear(new Date().getFullYear() - 10)).toISOString().split("T")[0] },
    { label: "Since 2015", date: "2015-01-01" },
    { label: "Since 2010", date: "2010-01-01" },
    { label: "Since 2003", date: "2003-01-01" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.38)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 10, padding: "28px 28px 24px", width: "100%", maxWidth: 420, boxShadow: "0 16px 48px rgba(0,0,0,0.14)", fontFamily: SYS }}>

        <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5 }}>Configure Backtest</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#111", marginBottom: 5 }}>Select Starting Date</div>
        <div style={{ fontSize: 13, color: "#555", lineHeight: 1.55, marginBottom: 22 }}>
          The backtest will simulate strategy performance from this date through today.
        </div>

        {/* Date picker */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#333", marginBottom: 6 }}>Backtest Start Date</div>
          <div style={{ border: `1.5px solid ${!isValid && date ? "#c62828" : "#ccc"}`, borderRadius: 6 }}>
            <input
              type="date"
              value={date}
              min={MIN_DATE}
              max={TODAY}
              onChange={e => setDate(e.target.value)}
              style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: 14, color: "#111", padding: "10px 12px", cursor: "pointer", fontFamily: SYS }}
            />
          </div>
          {date && date < MIN_DATE && (
            <div style={{ fontSize: 11, color: "#c62828", marginTop: 4, fontWeight: 500 }}>⚠ Data available from Jan 1, 2003 onwards</div>
          )}
        </div>

        {/* Duration preview */}
        {isValid && (
          <div style={{ background: "#f5f5f5", border: "1px solid #e0e0e0", borderRadius: 6, padding: "10px 14px", marginBottom: 20, display: "flex", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 2 }}>Backtest Period</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111", fontFamily: MONO }}>
                {new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} → Today
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 2 }}>Duration</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111", fontFamily: MONO }}>~{years} years</div>
            </div>
          </div>
        )}

        {/* Preset buttons */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Quick Presets</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {presets.map(p => (
              <button
                key={p.label}
                onClick={() => setDate(p.date)}
                style={{ padding: "5px 11px", borderRadius: 5, border: `1.5px solid ${date === p.date ? "#222" : "#ddd"}`, background: date === p.date ? "#222" : "#fff", fontSize: 11, fontWeight: 600, color: date === p.date ? "#fff" : "#444", cursor: "pointer", fontFamily: SYS }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: 11, borderRadius: 6, border: "1px solid #ccc", background: "#fff", fontSize: 13, fontWeight: 600, color: "#444", cursor: "pointer", fontFamily: SYS }}>
            Cancel
          </button>
          <button
            onClick={() => isValid && onConfirm(date)}
            disabled={!isValid}
            style={{ flex: 2, padding: 11, borderRadius: 6, border: "none", background: isValid ? "#222" : "#ccc", fontSize: 13, fontWeight: 700, color: "#fff", cursor: isValid ? "pointer" : "not-allowed", fontFamily: SYS }}
          >
            ⟳ Run Backtest
          </button>
        </div>

      </div>
    </div>
  );
}

// ─── CHART TOOLTIP ────────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label, suffix = "", decimals = 2 }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "7px 10px", boxShadow: "0 4px 12px rgba(0,0,0,0.09)", fontFamily: SYS }}>
      <div style={{ fontSize: 10, color: "#888", marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => p.value != null && (
        <div key={i} style={{ fontSize: 11, color: p.color || "#222", marginBottom: 2, fontFamily: MONO }}>
          {p.name}: {typeof p.value === "number" ? p.value.toFixed(decimals) : p.value}{suffix}
        </div>
      ))}
    </div>
  );
}

// ─── PERFORMANCE STATS TABLE ──────────────────────────────────────────────────
function StatsTable({ stats, startDate }) {
  // Each row: [label, value, optional color]
  const rows = [
    ["Universe",         stats.universe],
    ["Backtest Period",  `${startDate} → Today`],
    ["Initial Capital",  fmtRupee(stats.initialCap)],
    ["Final Value",      fmtRupee(stats.finalValue), "#1b6f3e"],
    null, // divider
    ["Total Return",     fmtPct(stats.totalReturn),  stats.totalReturn >= 0 ? "#1b6f3e" : "#c62828"],
    ["CAGR",             fmtPct(stats.cagr),         stats.cagr >= 0 ? "#1b6f3e" : "#c62828"],
    ["Ann. Volatility",  fmtPct(stats.vol)],
    ["Sharpe Ratio",     fmtNum(stats.sharpe),       stats.sharpe >= 1 ? "#1b6f3e" : stats.sharpe >= 0 ? "#9a5000" : "#c62828"],
    ["Max Drawdown",     fmtPct(stats.maxDrawdown),  "#c62828"],
    ["Calmar Ratio",     fmtNum(stats.calmar),       stats.calmar >= 0.5 ? "#1b6f3e" : "#9a5000"],
    null, // divider
    ["Win Rate (Daily)", fmtPct(stats.winRate)],
    ["Best Day",         fmtPct(stats.bestDay),      "#1b6f3e"],
    ["Worst Day",        fmtPct(stats.worstDay),     "#c62828"],
    ["Avg Cash Drag",    fmtPct(stats.avgCashDrag)],
  ];

  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "11px 16px", borderBottom: "1px solid #ebebeb", background: "#f8f8f8" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#111", textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: SYS }}>Performance Summary</span>
      </div>
      {rows.map((row, i) =>
        row === null
          ? <div key={`sep${i}`} style={{ height: 1, background: "#f0f0f0", margin: "0 16px" }} />
          : (
            <div key={row[0]} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 16px", background: i % 2 === 0 ? "#fafafa" : "#fff" }}>
              <span style={{ fontSize: 12, color: "#444", fontFamily: SYS }}>{row[0]}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: row[2] || "#111", fontFamily: MONO }}>{row[1]}</span>
            </div>
          )
      )}
    </div>
  );
}

// ─── CHART CARD WRAPPER ───────────────────────────────────────────────────────
function ChartCard({ num, title, height, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, overflow: "hidden", marginBottom: 10 }}>
      <div style={{ padding: "9px 16px", borderBottom: "1px solid #ebebeb", background: "#f8f8f8", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: "#444", padding: "2px 7px", borderRadius: 3, fontFamily: MONO }}>{num}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#333", textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: SYS }}>{title}</span>
      </div>
      <div style={{ padding: "10px 6px 6px", height }}>{children}</div>
    </div>
  );
}

// ─── BACKTEST RESULT CHARTS ───────────────────────────────────────────────────
function BacktestResult({ result, config, visible }) {
  const { series, stats } = result;

  // Shared X-axis props for all charts
  const xAxis = {
    dataKey: "date",
    tick: { fontFamily: MONO, fontSize: 9, fill: "#888" },
    tickFormatter: v => v?.slice(0, 4), // show only the year
    interval: Math.floor(series.length / 6),
    axisLine: { stroke: "#e8e8e8" },
    tickLine: false,
  };
  const yTick = { fontFamily: MONO, fontSize: 9, fill: "#888" };
  const grid  = { stroke: "#f0f0f0", strokeDasharray: "3 3" };

  return (
    <div style={{ marginTop: 22, opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(12px)", transition: "opacity 0.4s ease, transform 0.4s ease" }}>

      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#1b6f3e" }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: "#1b6f3e", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: SYS }}>
          Backtest Results · {config.backtestStartDate} → Today
        </span>
        <div style={{ flex: 1, height: 1, background: "#e0e0e0" }} />
      </div>

      <StatsTable stats={stats} startDate={config.backtestStartDate} />
      <div style={{ height: 12 }} />

      {/* C1: Equity Curve */}
      <ChartCard num="C1" title="Equity Curve — Invested vs Cash (₹ Lakhs)" height={200}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 14, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gInv"  x1="0" y1="0" x2="0" y2="1"><stop offset="5%"  stopColor="#3b5bdb" stopOpacity={0.6} /><stop offset="95%" stopColor="#3b5bdb" stopOpacity={0.04} /></linearGradient>
              <linearGradient id="gCash" x1="0" y1="0" x2="0" y2="1"><stop offset="5%"  stopColor="#74c0fc" stopOpacity={0.4} /><stop offset="95%" stopColor="#74c0fc" stopOpacity={0.02} /></linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis {...xAxis} />
            <YAxis tick={yTick} tickFormatter={v => `₹${v.toFixed(0)}L`} axisLine={false} tickLine={false} width={54} />
            <Tooltip content={<ChartTooltip suffix="L" decimals={2} />} />
            <Legend wrapperStyle={{ fontFamily: SYS, fontSize: 10, color: "#555" }} />
            <Area type="monotone" dataKey="investedL" name="Invested"  stackId="1" stroke="#3b5bdb" fill="url(#gInv)"  strokeWidth={1.5} dot={false} />
            <Area type="monotone" dataKey="cashL"     name="Cash"      stackId="1" stroke="#74c0fc" fill="url(#gCash)" strokeWidth={1}   dot={false} />
            <Area type="monotone" dataKey="pvL"       name="Total NAV"             stroke="#1b6f3e" fill="none"        strokeWidth={2}   dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* C2: Drawdown */}
      <ChartCard num="C2" title="Drawdown from Peak" height={150}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 14, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gDd" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#e03131" stopOpacity={0.5} /><stop offset="95%" stopColor="#e03131" stopOpacity={0.03} /></linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis {...xAxis} />
            <YAxis tick={yTick} tickFormatter={v => `${v.toFixed(1)}%`} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<ChartTooltip suffix="%" decimals={2} />} />
            <ReferenceLine y={0} stroke="#ccc" />
            <Area type="monotone" dataKey="drawdown" name="Drawdown" stroke="#e03131" fill="url(#gDd)" strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* C3: Rolling Sharpe */}
      <ChartCard num="C3" title="Rolling 1-Year Sharpe Ratio" height={150}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 4, right: 14, left: 0, bottom: 0 }}>
            <CartesianGrid {...grid} />
            <XAxis {...xAxis} />
            <YAxis tick={yTick} tickFormatter={v => v.toFixed(1)} axisLine={false} tickLine={false} width={34} />
            <Tooltip content={<ChartTooltip decimals={2} />} />
            <ReferenceLine y={0} stroke="#ccc" strokeDasharray="4 3" />
            <ReferenceLine y={1} stroke="#1b6f3e" strokeDasharray="4 3" strokeOpacity={0.45} />
            <Line type="monotone" dataKey="rollingSharpe" name="Sharpe (1Y)" stroke="#2f9e44" strokeWidth={1.5} dot={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* C4: Holdings count */}
      <ChartCard num="C4" title="Number of Holdings" height={125}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 14, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gH" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#7048e8" stopOpacity={0.4} /><stop offset="95%" stopColor="#7048e8" stopOpacity={0.03} /></linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis {...xAxis} />
            <YAxis tick={yTick} tickFormatter={v => Math.round(v)} axisLine={false} tickLine={false} width={26} domain={[0, config.numStocks + 3]} />
            <Tooltip content={<ChartTooltip decimals={0} />} />
            <Area type="stepAfter" dataKey="holdings" name="# Stocks" stroke="#7048e8" fill="url(#gH)" strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function DeployStrategy() {
  const navigate = useNavigate();

  // Form state
  const [form,   setForm]   = useState(DEFAULT_FORM);
  const [errors, setErrors] = useState({});

  // Loading states
  const [btLoading,  setBtLoading]  = useState(false);
  const [depLoading, setDepLoading] = useState(false);

  // UI state
  const [showModal,     setShowModal]     = useState(false);
  const [btError,       setBtError]       = useState(null);
  const [btResult,      setBtResult]      = useState(null);
  const [btConfig,      setBtConfig]      = useState(null);
  const [resultVisible, setResultVisible] = useState(false);
  const [mounted,       setMounted]       = useState(false);

  const resultRef = useRef(null);

  // Fade-in on mount
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 40);
    return () => clearTimeout(t);
  }, []);

  // Generic form field updater
  function setField(key) {
    return e => {
      const val = e.target.type === "number" ? Number(e.target.value) : e.target.value;
      setForm(prev => ({ ...prev, [key]: val }));
      setErrors(prev => ({ ...prev, [key]: undefined }));
    };
  }

  // Switch between monthly / weekly rebalancing
  function setRebalanceType(type) {
    setForm(prev => ({ ...prev, rebalanceType: type, rebalanceFreq: 1, startingDate: TODAY }));
  }

  // Validate then open modal
  function handleBacktestClick() {
    const errs = validateForm(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setShowModal(true);
  }

  // Called when user picks a date and confirms in the modal
  async function runBacktest(backtestStartDate) {
    setShowModal(false);
    const config = { ...form, backtestStartDate };

    setBtLoading(true);
    setBtResult(null);
    setResultVisible(false);
    setBtError(null);

    try {
      const result = await postJSON(`${BASE_URL}/api/strategy/backtest`, config);
      setBtConfig(config);
      setBtResult(result);
      setTimeout(() => setResultVisible(true), 80);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 220);
    } catch (err) {
      setBtError(err.message || "An unexpected error occurred.");
    } finally {
      setBtLoading(false);
    }
  }

  // Deploy live
  async function handleDeploy() {
    const errs = validateForm(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setDepLoading(true);
    try {
      await postJSON(`${BASE_URL}/api/strategy/deploy`, form);
      navigate("/dashboard");
    } catch (err) {
      console.error("Deploy error:", err);
    } finally {
      setDepLoading(false);
    }
  }

  const anyLoading = btLoading || depLoading;
  const isWeekly   = form.rebalanceType === "weekly";

  // Helper for frequency label e.g. "Every 2 months"
  const freqLabel = n => isWeekly ? `Every ${n} week${n > 1 ? "s" : ""}` : `Every ${n} month${n > 1 ? "s" : ""}`;

  // Summary rows shown in the right sidebar
  const summaryRows = [
    ["Universe",  UNIVERSES.find(u => u.value === form.universe)?.label || "—"],
    ["Stocks",    String(form.numStocks || "—")],
    ["Lookback",  `${form.lookback1}M + ${form.lookback2}M`],
    ["Capital",   form.capital ? fmtRupee(form.capital) : "—"],
    ["Rebalance", isWeekly ? "Weekly" : "Monthly"],
    ["Frequency", isWeekly ? `Every ${form.rebalanceFreq}W` : `Every ${form.rebalanceFreq}M`],
    ["Starts",    form.startingDate || "—"],
    ["Price Cap", form.priceCap ? fmtRupee(form.priceCap) : "None"],
  ];

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .dp-root  { min-height: calc(100vh - 60px); background: #f2f2f2; padding: 28px 28px 72px; font-family: ${SYS}; }
        .dp-wrap  { max-width: 1180px; margin: 0 auto; opacity: 0; transform: translateY(10px); transition: opacity 0.35s ease, transform 0.35s ease; }
        .dp-wrap.mounted { opacity: 1; transform: translateY(0); }

        /* Two-column layout: form | sidebar */
        .dp-layout { display: grid; grid-template-columns: 1fr 296px; gap: 14px; align-items: start; }
        @media (max-width: 840px) { .dp-layout { grid-template-columns: 1fr; } .dp-root { padding: 16px 14px 60px; } }

        .dp-side { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 14px; }

        /* Grid helpers */
        .g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .g4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
        @media (max-width: 540px) { .g2 { grid-template-columns: 1fr; } .g4 { grid-template-columns: repeat(2, 1fr); } }

        /* Universe option cards */
        .uni-opt       { padding: 11px 8px; border-radius: 6px; cursor: pointer; border: 1.5px solid #ddd; background: #fff; text-align: center; transition: border-color 0.13s; user-select: none; }
        .uni-opt:hover { border-color: #999; }
        .uni-opt.sel   { border-color: #222; background: #f0f0f0; }
        .uni-name { font-size: 13px; font-weight: 700; color: #111; margin-bottom: 2px; }
        .uni-desc { font-size: 10px; color: #777; }

        /* Monthly / Weekly toggle */
        .rtoggle           { display: flex; border: 1px solid #ddd; border-radius: 6px; overflow: hidden; background: #f5f5f5; margin-bottom: 14px; }
        .rtbtn             { flex: 1; padding: 9px 12px; font-size: 12px; font-weight: 600; border: none; cursor: pointer; background: transparent; color: #555; text-transform: uppercase; letter-spacing: 0.03em; transition: all 0.14s; display: flex; align-items: center; justify-content: center; gap: 5px; }
        .rtbtn:first-child { border-right: 1px solid #ddd; }
        .rtbtn.on          { background: #222; color: #fff; }

        /* Summary sidebar */
        .dp-summary       { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px 16px; }
        .dp-summary-title { font-size: 11px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 12px; }
        .dp-sgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .dp-sk    { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1px; }
        .dp-sv    { font-size: 13px; font-weight: 700; color: #111; font-family: ${MONO}; }

        /* Action buttons */
        .dp-btn-row          { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 4px; }
        .dp-btn              { padding: 13px 16px; border-radius: 7px; font-size: 13px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; cursor: pointer; border: none; display: flex; align-items: center; justify-content: center; gap: 7px; transition: all 0.15s; font-family: ${SYS}; }
        .dp-btn:disabled     { opacity: 0.5; cursor: not-allowed; }
        .dp-btn.outline      { background: #fff; color: #333; border: 1.5px solid #ccc; }
        .dp-btn.outline:hover:not(:disabled) { background: #f5f5f5; border-color: #888; }
        .dp-btn.solid        { background: #222; color: #fff; }
        .dp-btn.solid:hover:not(:disabled)   { background: #3a3a3a; }

        /* Loading dots */
        .dots      { display: flex; gap: 3px; align-items: center; }
        .dots span { width: 4px; height: 4px; border-radius: 50%; background: currentColor; animation: dot 0.9s ease-in-out infinite; }
        .dots span:nth-child(2) { animation-delay: 0.15s; }
        .dots span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes dot { 0%,80%,100%{transform:scale(1);opacity:0.5} 40%{transform:scale(1.4);opacity:1} }

        @keyframes fadeUp { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
        .fade-up { animation: fadeUp 0.2s ease; }
      `}</style>

      {/* Backtest date modal */}
      {showModal && (
        <BacktestDateModal onConfirm={runBacktest} onCancel={() => setShowModal(false)} />
      )}

      <div className="dp-root">
        <div className={`dp-wrap ${mounted ? "mounted" : ""}`}>

          {/* Page header */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#777", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Strategy Configuration</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#111", marginBottom: 3 }}>Deploy Strategy</div>
            <div style={{ fontSize: 13, color: "#555", lineHeight: 1.5 }}>Configure your momentum strategy parameters before backtesting or going live.</div>
          </div>

          <div className="dp-layout">

            {/* ── LEFT: Form ── */}
            <div>

              {/* Section 1: Universe */}
              <Section number="1" title="Stock Universe">
                <Label hint="— pool of stocks the strategy selects from">Universe</Label>
                <div className="g4" style={{ marginTop: 6 }}>
                  {UNIVERSES.map(opt => (
                    <div
                      key={opt.value}
                      className={`uni-opt ${form.universe === opt.value ? "sel" : ""}`}
                      onClick={() => { setForm(f => ({ ...f, universe: opt.value })); setErrors(e => ({ ...e, universe: undefined })); }}
                    >
                      <div className="uni-name">{opt.label}</div>
                      <div className="uni-desc">{opt.desc}</div>
                    </div>
                  ))}
                </div>
                <FieldError msg={errors.universe} />
              </Section>

              {/* Section 2: Portfolio */}
              <Section number="2" title="Portfolio Parameters">
                <div className="g2">
                  <div>
                    <Label hint="— stocks held at any time">No. of Stocks</Label>
                    <NumberInput value={form.numStocks} onChange={setField("numStocks")} placeholder="e.g. 10" suffix="stocks" error={errors.numStocks} />
                    <FieldError msg={errors.numStocks} />
                  </div>
                  <div>
                    <Label hint="— optional max price filter">Stock Price Cap</Label>
                    <NumberInput value={form.priceCap} onChange={setField("priceCap")} placeholder="No limit" prefix="₹" />
                  </div>
                </div>
              </Section>

              {/* Section 3: Lookback */}
              <Section number="3" title="Lookback Periods">
                <div className="g2">
                  <div>
                    <Label hint="— primary return window">Period 1</Label>
                    <Dropdown value={form.lookback1} onChange={setField("lookback1")} options={MONTHS.map(n => ({ value: n, label: `${n} month${n > 1 ? "s" : ""}` }))} error={errors.lookback1} />
                    <FieldError msg={errors.lookback1} />
                  </div>
                  <div>
                    <Label hint="— secondary return window">Period 2</Label>
                    <Dropdown value={form.lookback2} onChange={setField("lookback2")} options={MONTHS.map(n => ({ value: n, label: `${n} month${n > 1 ? "s" : ""}` }))} error={errors.lookback2} />
                    <FieldError msg={errors.lookback2} />
                  </div>
                </div>
                <Hint>Two different windows (e.g. <strong>6M + 12M</strong>) reduce signal noise and improve rank stability.</Hint>
              </Section>

              {/* Section 4: Capital & Rebalancing */}
              <Section number="4" title="Capital & Rebalancing">
                <div style={{ marginBottom: 16 }}>
                  <Label hint="— total amount to deploy">Capital</Label>
                  <NumberInput value={form.capital} onChange={setField("capital")} placeholder="e.g. 500000" prefix="₹" error={errors.capital} />
                  <FieldError msg={errors.capital} />
                </div>

                <Label hint="— schedule cadence">Rebalance Type</Label>
                <div className="rtoggle">
                  <button className={`rtbtn ${!isWeekly ? "on" : ""}`} onClick={() => setRebalanceType("monthly")}>📅 Monthly</button>
                  <button className={`rtbtn ${isWeekly  ? "on" : ""}`} onClick={() => setRebalanceType("weekly")}>⚡ Weekly</button>
                </div>

                <div key={isWeekly ? "w" : "m"} className="fade-up">
                  <div className="g2">
                    <div>
                      <Label hint={isWeekly ? "— 1 to 52 weeks" : "— 1 to 12 months"}>Frequency</Label>
                      <Dropdown
                        value={form.rebalanceFreq}
                        onChange={setField("rebalanceFreq")}
                        options={(isWeekly ? WEEKS : MONTHS).map(n => ({ value: n, label: freqLabel(n) }))}
                      />
                    </div>
                    <div>
                      <Label hint="— first rebalance date">Starting Date</Label>
                      <div style={{ border: "1.5px solid #ccc", borderRadius: 6, background: "#fff" }}>
                        <input
                          type="date"
                          value={form.startingDate}
                          onChange={setField("startingDate")}
                          min={TODAY}
                          style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: 13, color: "#111", padding: "9px 11px", cursor: "pointer", fontFamily: SYS }}
                        />
                      </div>
                    </div>
                  </div>
                  <Hint>
                    Starts <strong>{form.startingDate || "—"}</strong>, rebalances <strong>{freqLabel(form.rebalanceFreq)}</strong>.
                    {isWeekly ? " Higher frequency increases turnover costs." : " Lower frequency reduces transaction costs."}
                  </Hint>
                </div>
              </Section>

              {/* Backtest / Deploy buttons */}
              <div className="dp-btn-row">
                <button className="dp-btn outline" onClick={handleBacktestClick} disabled={anyLoading}>
                  {btLoading ? <><span>Running</span><LoadingDots /></> : <><span>⟳</span> Backtest</>}
                </button>
                <button className="dp-btn solid" onClick={handleDeploy} disabled={anyLoading}>
                  {depLoading ? <><span>Deploying</span><LoadingDots /></> : <><span>▶</span> Deploy Live</>}
                </button>
              </div>

              {btError && <ErrorBanner message={btError} onDismiss={() => setBtError(null)} />}
            </div>

            {/* ── RIGHT: Sticky Sidebar ── */}
            <div className="dp-side">

              {/* Config summary */}
              <div className="dp-summary">
                <div className="dp-summary-title">Configuration Summary</div>
                <div className="dp-sgrid">
                  {summaryRows.map(([k, v]) => (
                    <div key={k}>
                      <div className="dp-sk">{k}</div>
                      <div className="dp-sv">{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick tips */}
              <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#555", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>Quick Tips</div>
                {[
                  ["Universe", "Larger universes offer more diversification but more diluted signals."],
                  ["Lookback",  "Combining 6M + 12M windows is a classic momentum setup."],
                  ["Capital",   "Ensure capital covers at least 1 lot per stock in the portfolio."],
                ].map(([t, tip], i, arr) => (
                  <div key={t} style={{ marginBottom: i < arr.length - 1 ? 10 : 0, paddingBottom: i < arr.length - 1 ? 10 : 0, borderBottom: i < arr.length - 1 ? "1px solid #f0f0f0" : "none" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#222", marginBottom: 2 }}>{t}</div>
                    <div style={{ fontSize: 12, color: "#444", lineHeight: 1.5 }}>{tip}</div>
                  </div>
                ))}
              </div>

            </div>
          </div>

          {/* Backtest results (full width, below the form) */}
          <div ref={resultRef}>
            {btResult && btConfig && (
              <BacktestResult result={btResult} config={btConfig} visible={resultVisible} />
            )}
          </div>

        </div>
      </div>
    </>
  );
}