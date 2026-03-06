import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart, Area, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const API_ENDPOINTS = {
  backtest: `${API_BASE_URL}/api/strategy/backtest`,
  deploy:   `${API_BASE_URL}/api/strategy/deploy`,
};

// ── STATIC DATA START ────────────────────────────────────────────────────────
function generateMockBacktest(config) {
  const capital    = Number(config.capital);
  const startDate  = new Date(config.backtestStartDate);
  const endDate    = new Date();
  const series = [];
  let pv = capital, cash = capital * 0.05, invested = capital * 0.95;
  let peak = pv, maxDd = 0;
  const dailyRets = [];
  let d = new Date(startDate);
  while (d <= endDate) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      const drift = 0.00068, noise = 0.011 * (Math.random() * 2 - 1), ret = drift + noise;
      invested *= (1 + ret); cash *= 0.9998; pv = invested + cash;
      if (pv > peak) peak = pv;
      const dd = (pv - peak) / peak;
      if (dd < maxDd) maxDd = dd;
      dailyRets.push(ret);
      series.push({ date: d.toISOString().split("T")[0], pv: +pv.toFixed(2), cash: +cash.toFixed(2), invested: +invested.toFixed(2), drawdown: +(dd * 100).toFixed(3), holdings: config.numStocks - (Math.random() < 0.3 ? 1 : 0), rollingSharpe: null });
    }
    d.setDate(d.getDate() + 1);
  }
  const W = 252;
  series.forEach((pt, i) => {
    if (i < W) return;
    const sl = dailyRets.slice(i - W, i), mean = sl.reduce((a, b) => a + b, 0) / W;
    const std = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / W);
    pt.rollingSharpe = std > 0 ? +(mean / std * Math.sqrt(252)).toFixed(3) : null;
  });
  const yearMap = {};
  series.forEach(pt => { const yr = pt.date.slice(0, 4); if (!yearMap[yr]) yearMap[yr] = { start: pt.pv, end: pt.pv }; yearMap[yr].end = pt.pv; });
  const yearlyReturns = Object.entries(yearMap).map(([year, { start, end }]) => ({ year, ret: +((end - start) / start * 100).toFixed(2) }));
  const years = (endDate - startDate) / (365.25 * 86400000), totRet = (pv - capital) / capital;
  const cagr = Math.pow(1 + totRet, 1 / Math.max(years, 0.1)) - 1;
  const mean = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
  const std = Math.sqrt(dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyRets.length);
  const vol = std * Math.sqrt(252), sharpe = (cagr - 0.065) / vol, calmar = Math.abs(maxDd) > 0 ? cagr / Math.abs(maxDd) : 0;
  const winRate = dailyRets.filter(r => r > 0).length / dailyRets.length;
  const avgCash = series.reduce((a, b) => a + b.cash / b.pv, 0) / series.length;
  const lakh = 1e5;
  const thin = series.filter((_, i) => i % 5 === 0).map(pt => ({ ...pt, pvL: +(pt.pv / lakh).toFixed(3), cashL: +(pt.cash / lakh).toFixed(3), investedL: +(pt.invested / lakh).toFixed(3) }));
  return { series: thin, yearlyReturns, stats: { universe: config.universe.toUpperCase(), initialCap: capital, finalValue: +pv.toFixed(2), totalReturn: totRet, cagr, vol, sharpe: +sharpe.toFixed(2), maxDrawdown: maxDd, calmar: +calmar.toFixed(2), winRate, bestDay: Math.max(...dailyRets), worstDay: Math.min(...dailyRets), avgCashDrag: avgCash } };
}
// ── STATIC DATA END ──────────────────────────────────────────────────────────

const strategyService = {
  backtest: async (config) => { await new Promise(r => setTimeout(r, 2000)); return generateMockBacktest(config); },
  deploy:   async (config) => { await new Promise(r => setTimeout(r, 1800)); return { success: true }; },
};

const UNIVERSE_OPTIONS = [
  { value: "nifty50",  label: "Nifty 50",  desc: "Large cap · 50 stocks"    },
  { value: "nifty100", label: "Nifty 100", desc: "Large cap · 100 stocks"   },
  { value: "nifty150", label: "Nifty 150", desc: "Large + Mid · 150 stocks" },
  { value: "nifty250", label: "Nifty 250", desc: "Large + Mid · 250 stocks" },
];
const LOOKBACK_OPTIONS     = Array.from({ length: 12 }, (_, i) => i + 1);
const MONTHLY_FREQ_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);
const WEEKLY_FREQ_OPTIONS  = Array.from({ length: 52 }, (_, i) => i + 1);
const TODAY                = new Date().toISOString().split("T")[0];
const MIN_BACKTEST_DATE    = "2003-01-01";
const CURRENT_YEAR         = new Date().getFullYear();

const DEFAULT_FORM = {
  universe: "nifty50", numStocks: 10,
  lookback1: 6, lookback2: 12,
  priceCap: "", capital: "",
  rebalanceType: "monthly", rebalanceFreq: 1, startingDate: TODAY,
};

function validate(form) {
  const e = {};
  if (!form.universe)                                e.universe  = "Select a universe";
  if (!form.numStocks || form.numStocks < 1)         e.numStocks = "Minimum 1 stock required";
  if (form.lookback1 === form.lookback2)             e.lookback2 = "Must differ from Period 1";
  if (!form.capital || Number(form.capital) < 10000) e.capital   = "Minimum ₹10,000 required";
  return e;
}

const fmt  = v => `${(v * 100).toFixed(2)}%`;
const fmtN = (v, d = 2) => v.toFixed(d);
const fmtC = v => `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

// ─── PRIMITIVES ──────────────────────────────────────────────────────────────
function Label({ children, hint }) {
  return (
    <div style={{ marginBottom: 6, display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#111", fontFamily: SYS }}>{children}</span>
      {hint && <span style={{ fontSize: 11, color: "#777", fontFamily: SYS }}>{hint}</span>}
    </div>
  );
}

function FieldError({ msg }) {
  if (!msg) return null;
  return <div style={{ fontSize: 11, color: "#c62828", marginTop: 4, fontWeight: 500, fontFamily: SYS }}>⚠ {msg}</div>;
}

function Input({ value, onChange, placeholder, prefix, suffix, error }) {
  const [f, setF] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", border: `1.5px solid ${error ? "#c62828" : f ? "#333" : "#ccc"}`, borderRadius: 6, background: "#fff", boxShadow: f ? "0 0 0 3px rgba(0,0,0,0.07)" : "none", transition: "border-color 0.14s, box-shadow 0.14s" }}>
      {prefix && <span style={{ fontSize: 13, color: "#555", padding: "0 0 0 11px", fontFamily: SYS, userSelect: "none" }}>{prefix}</span>}
      <input type="number" value={value} onChange={onChange} placeholder={placeholder}
        onFocus={() => setF(true)} onBlur={() => setF(false)}
        style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 14, color: "#111", padding: prefix ? "9px 11px 9px 5px" : "9px 11px", fontFamily: SYS }} />
      {suffix && <span style={{ fontSize: 11, color: "#777", padding: "0 11px 0 0", fontFamily: SYS, userSelect: "none" }}>{suffix}</span>}
    </div>
  );
}

function Select({ value, onChange, options, error }) {
  const [f, setF] = useState(false);
  return (
    <div style={{ border: `1.5px solid ${error ? "#c62828" : f ? "#333" : "#ccc"}`, borderRadius: 6, background: "#fff", position: "relative", boxShadow: f ? "0 0 0 3px rgba(0,0,0,0.07)" : "none", transition: "border-color 0.14s, box-shadow 0.14s" }}>
      <select value={value} onChange={onChange} onFocus={() => setF(true)} onBlur={() => setF(false)}
        style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: 13, color: "#111", padding: "9px 32px 9px 11px", appearance: "none", cursor: "pointer", fontFamily: SYS }}>
        {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
      </select>
      <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "#888", fontSize: 10, pointerEvents: "none" }}>▼</span>
    </div>
  );
}

function Section({ number, title, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "11px 18px", borderBottom: "1px solid #ebebeb", display: "flex", alignItems: "center", gap: 10, background: "#f8f8f8" }}>
        <span style={{ width: 22, height: 22, borderRadius: 5, background: "#222", color: "#fff", fontSize: 11, fontWeight: 700, fontFamily: SYS, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{number}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#111", textTransform: "uppercase", letterSpacing: "0.02em", fontFamily: SYS }}>{title}</span>
      </div>
      <div style={{ padding: "16px 18px" }}>{children}</div>
    </div>
  );
}

// ─── BACKTEST DATE MODAL ──────────────────────────────────────────────────────
function BacktestDateModal({ onConfirm, onCancel }) {
  const defaultDate = "2015-01-01";
  const [date, setDate] = useState(defaultDate);
  const [focused, setFocused] = useState(false);

  const daysDiff = date
    ? Math.floor((new Date() - new Date(date)) / (1000 * 60 * 60 * 24))
    : 0;
  const yearsDiff = date
    ? ((new Date() - new Date(date)) / (365.25 * 86400000)).toFixed(1)
    : 0;

  const isValid = date && date >= MIN_BACKTEST_DATE && date < TODAY;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.38)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 10, padding: "28px 28px 24px", width: "100%", maxWidth: 420, boxShadow: "0 16px 48px rgba(0,0,0,0.14)", fontFamily: SYS }}>

        {/* Header */}
        <div style={{ fontSize: 11, fontWeight: 600, color: "#888", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 5 }}>Configure Backtest</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#111", marginBottom: 5 }}>Select Starting Date</div>
        <div style={{ fontSize: 13, color: "#555", lineHeight: 1.55, marginBottom: 22 }}>
          The backtest will simulate strategy performance from this date through today.
        </div>

        {/* Date input */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#333", marginBottom: 6 }}>Backtest Start Date</div>
          <div style={{
            border: `1.5px solid ${!isValid && date ? "#c62828" : focused ? "#333" : "#ccc"}`,
            borderRadius: 6, background: "#fff",
            boxShadow: focused ? "0 0 0 3px rgba(0,0,0,0.07)" : "none",
            transition: "border-color 0.14s, box-shadow 0.14s",
          }}>
            <input
              type="date"
              value={date}
              min={MIN_BACKTEST_DATE}
              max={TODAY}
              onChange={e => setDate(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: 14, color: "#111", padding: "10px 12px", cursor: "pointer", fontFamily: SYS }}
            />
          </div>
          {date && date < MIN_BACKTEST_DATE && (
            <div style={{ fontSize: 11, color: "#c62828", marginTop: 4, fontWeight: 500 }}>⚠ Data available from Jan 1, 2003 onwards</div>
          )}
        </div>

        {/* Duration preview */}
        {isValid && (
          <div style={{ background: "#f5f5f5", border: "1px solid #e0e0e0", borderRadius: 6, padding: "10px 14px", marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>Backtest Period</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111", fontFamily: MONO }}>
                {new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} → Today
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>Duration</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111", fontFamily: MONO }}>~{yearsDiff} years</div>
            </div>
          </div>
        )}

        {/* Quick presets */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Quick Presets</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              { label: "1 Year",  date: new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString().split("T")[0] },
              { label: "3 Years", date: new Date(new Date().setFullYear(new Date().getFullYear() - 3)).toISOString().split("T")[0] },
              { label: "5 Years", date: new Date(new Date().setFullYear(new Date().getFullYear() - 5)).toISOString().split("T")[0] },
              { label: "10 Years",date: new Date(new Date().setFullYear(new Date().getFullYear() - 10)).toISOString().split("T")[0] },
              { label: "Since 2015", date: "2015-01-01" },
              { label: "Since 2010", date: "2010-01-01" },
              { label: "Since 2003", date: "2003-01-01" },
            ].map(p => (
              <button key={p.label} onClick={() => setDate(p.date)} style={{
                padding: "5px 11px", borderRadius: 5,
                border: `1.5px solid ${date === p.date ? "#222" : "#ddd"}`,
                background: date === p.date ? "#222" : "#fff",
                fontSize: 11, fontWeight: 600,
                color: date === p.date ? "#fff" : "#444",
                cursor: "pointer", transition: "all 0.12s", fontFamily: SYS,
              }}>{p.label}</button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "11px", borderRadius: 6, border: "1px solid #ccc", background: "#fff", fontSize: 13, fontWeight: 600, color: "#444", cursor: "pointer", fontFamily: SYS }}>
            Cancel
          </button>
          <button
            onClick={() => isValid && onConfirm(date)}
            disabled={!isValid}
            style={{ flex: 2, padding: "11px", borderRadius: 6, border: "none", background: isValid ? "#222" : "#ccc", fontSize: 13, fontWeight: 700, color: "#fff", cursor: isValid ? "pointer" : "not-allowed", fontFamily: SYS, transition: "background 0.14s" }}
          >
            ⟳ Run Backtest
          </button>
        </div>

      </div>
    </div>
  );
}

// ─── CHART TOOLTIP ───────────────────────────────────────────────────────────
function ChartTip({ active, payload, label, suffix = "", decimals = 2 }) {
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

// ─── STATS TABLE ─────────────────────────────────────────────────────────────
function StatsTable({ stats, startDate }) {
  const rows = [
    { label: "Universe",         value: stats.universe },
    { label: "Backtest Period",  value: `${startDate} → Today` },
    { label: "Initial Capital",  value: fmtC(stats.initialCap) },
    { label: "Final Value",      value: fmtC(stats.finalValue), color: "#1b6f3e" },
    null,
    { label: "Total Return",     value: fmt(stats.totalReturn),  color: stats.totalReturn >= 0 ? "#1b6f3e" : "#c62828" },
    { label: "CAGR",             value: fmt(stats.cagr),         color: stats.cagr >= 0 ? "#1b6f3e" : "#c62828" },
    { label: "Ann. Volatility",  value: fmt(stats.vol) },
    { label: "Sharpe Ratio",     value: fmtN(stats.sharpe),      color: stats.sharpe >= 1 ? "#1b6f3e" : stats.sharpe >= 0 ? "#9a5000" : "#c62828" },
    { label: "Max Drawdown",     value: fmt(stats.maxDrawdown),  color: "#c62828" },
    { label: "Calmar Ratio",     value: fmtN(stats.calmar),      color: stats.calmar >= 0.5 ? "#1b6f3e" : "#9a5000" },
    null,
    { label: "Win Rate (Daily)", value: fmt(stats.winRate) },
    { label: "Best Day",         value: fmt(stats.bestDay),      color: "#1b6f3e" },
    { label: "Worst Day",        value: fmt(stats.worstDay),     color: "#c62828" },
    { label: "Avg Cash Drag",    value: fmt(stats.avgCashDrag) },
  ];
  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "11px 16px", borderBottom: "1px solid #ebebeb", background: "#f8f8f8" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#111", textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: SYS }}>Performance Summary</span>
      </div>
      {rows.map((row, i) =>
        row === null ? (
          <div key={`sep${i}`} style={{ height: 1, background: "#f0f0f0", margin: "0 16px" }} />
        ) : (
          <div key={row.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 16px", background: i % 2 === 0 ? "#fafafa" : "#fff" }}>
            <span style={{ fontSize: 12, color: "#444", fontFamily: SYS }}>{row.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: row.color || "#111", fontFamily: MONO }}>{row.value}</span>
          </div>
        )
      )}
    </div>
  );
}

// ─── CHART CARD ──────────────────────────────────────────────────────────────
function ChartCard({ num, title, height = 190, children }) {
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

// ─── BACKTEST RESULT ─────────────────────────────────────────────────────────
function BacktestResult({ result, config, visible }) {
  const { series, stats } = result;
  const xProps = { dataKey: "date", tick: { fontFamily: MONO, fontSize: 9, fill: "#888" }, tickFormatter: v => v ? v.slice(0, 4) : "", interval: Math.floor(series.length / 6), axisLine: { stroke: "#e8e8e8" }, tickLine: false };
  const yStyle = { fontFamily: MONO, fontSize: 9, fill: "#888" };
  const grid   = { stroke: "#f0f0f0", strokeDasharray: "3 3" };

  return (
    <div style={{ marginTop: 22, opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(12px)", transition: "opacity 0.4s ease, transform 0.4s ease" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#1b6f3e" }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: "#1b6f3e", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: SYS }}>
          Backtest Results · {config.backtestStartDate} → Today
        </span>
        <div style={{ flex: 1, height: 1, background: "#e0e0e0" }} />
      </div>

      <StatsTable stats={stats} startDate={config.backtestStartDate} />
      <div style={{ height: 12 }} />

      <ChartCard num="C1" title="Equity Curve — Invested vs Cash (₹ Lakhs)" height={200}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 14, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gInv" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b5bdb" stopOpacity={0.6} /><stop offset="95%" stopColor="#3b5bdb" stopOpacity={0.04} /></linearGradient>
              <linearGradient id="gCash" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#74c0fc" stopOpacity={0.4} /><stop offset="95%" stopColor="#74c0fc" stopOpacity={0.02} /></linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis {...xProps} />
            <YAxis tick={yStyle} tickFormatter={v => `₹${v.toFixed(0)}L`} axisLine={false} tickLine={false} width={54} />
            <Tooltip content={<ChartTip suffix="L" decimals={2} />} />
            <Legend wrapperStyle={{ fontFamily: SYS, fontSize: 10, color: "#555" }} />
            <Area type="monotone" dataKey="investedL" name="Invested"  stackId="1" stroke="#3b5bdb" fill="url(#gInv)"  strokeWidth={1.5} dot={false} />
            <Area type="monotone" dataKey="cashL"     name="Cash"      stackId="1" stroke="#74c0fc" fill="url(#gCash)" strokeWidth={1}   dot={false} />
            <Area type="monotone" dataKey="pvL"       name="Total NAV"             stroke="#1b6f3e" fill="none"        strokeWidth={2}   dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard num="C2" title="Drawdown from Peak" height={150}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 14, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gDd" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#e03131" stopOpacity={0.5} /><stop offset="95%" stopColor="#e03131" stopOpacity={0.03} /></linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis {...xProps} />
            <YAxis tick={yStyle} tickFormatter={v => `${v.toFixed(1)}%`} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<ChartTip suffix="%" decimals={2} />} />
            <ReferenceLine y={0} stroke="#ccc" />
            <Area type="monotone" dataKey="drawdown" name="Drawdown" stroke="#e03131" fill="url(#gDd)" strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard num="C3" title="Rolling 1-Year Sharpe Ratio" height={150}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 4, right: 14, left: 0, bottom: 0 }}>
            <CartesianGrid {...grid} />
            <XAxis {...xProps} />
            <YAxis tick={yStyle} tickFormatter={v => v.toFixed(1)} axisLine={false} tickLine={false} width={34} />
            <Tooltip content={<ChartTip decimals={2} />} />
            <ReferenceLine y={0} stroke="#ccc" strokeDasharray="4 3" />
            <ReferenceLine y={1} stroke="#1b6f3e" strokeDasharray="4 3" strokeOpacity={0.45} />
            <Line type="monotone" dataKey="rollingSharpe" name="Sharpe (1Y)" stroke="#2f9e44" strokeWidth={1.5} dot={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard num="C4" title="Number of Holdings" height={125}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 14, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gH" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#7048e8" stopOpacity={0.4} /><stop offset="95%" stopColor="#7048e8" stopOpacity={0.03} /></linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis {...xProps} />
            <YAxis tick={yStyle} tickFormatter={v => Math.round(v)} axisLine={false} tickLine={false} width={26} domain={[0, config.numStocks + 3]} />
            <Tooltip content={<ChartTip decimals={0} />} />
            <Area type="stepAfter" dataKey="holdings" name="# Stocks" stroke="#7048e8" fill="url(#gH)" strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
export default function DeployStrategy() {
  const navigate = useNavigate();
  const [form, setForm]                     = useState(DEFAULT_FORM);
  const [errors, setErrors]                 = useState({});
  const [btLoading, setBtLoading]           = useState(false);
  const [depLoading, setDepLoading]         = useState(false);
  const [showDateModal, setShowDateModal]   = useState(false);
  const [backtestResult, setBacktestResult] = useState(null);
  const [backtestConfig, setBacktestConfig] = useState(null);
  const [resultVisible, setResultVisible]   = useState(false);
  const [mounted, setMounted]               = useState(false);
  const resultRef = useRef(null);

  useEffect(() => { const t = setTimeout(() => setMounted(true), 40); return () => clearTimeout(t); }, []);

  const set = key => e => {
    const val = e.target.type === "number" ? Number(e.target.value) : e.target.value;
    setForm(f => ({ ...f, [key]: val }));
    setErrors(er => ({ ...er, [key]: undefined }));
  };
  const setRebalanceType = type => setForm(f => ({ ...f, rebalanceType: type, rebalanceFreq: 1, startingDate: TODAY }));

  const handleBacktestClick = () => {
    const errs = validate(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setShowDateModal(true);
  };

  const runBacktest = async (backtestStartDate) => {
    setShowDateModal(false);
    const config = { ...form, backtestStartDate };
    setBtLoading(true); setBacktestResult(null); setResultVisible(false);
    try {
      const result = await strategyService.backtest(config);
      setBacktestConfig(config); setBacktestResult(result);
      setTimeout(() => setResultVisible(true), 80);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 220);
    } catch (err) { console.error("Backtest error:", err); }
    finally { setBtLoading(false); }
  };

  const handleDeploy = async () => {
    const errs = validate(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setDepLoading(true);
    try { await strategyService.deploy(form); navigate("/dashboard"); }
    catch (err) { console.error("Deploy error:", err); }
    finally { setDepLoading(false); }
  };

  const anyLoading = btLoading || depLoading;
  const isWeekly   = form.rebalanceType === "weekly";

  const summaryRows = [
    ["Universe",  UNIVERSE_OPTIONS.find(o => o.value === form.universe)?.label || "—"],
    ["Stocks",    String(form.numStocks || "—")],
    ["Lookback",  `${form.lookback1}M + ${form.lookback2}M`],
    ["Capital",   form.capital ? `₹${Number(form.capital).toLocaleString("en-IN")}` : "—"],
    ["Rebalance", isWeekly ? "Weekly" : "Monthly"],
    ["Frequency", isWeekly ? `Every ${form.rebalanceFreq}W` : `Every ${form.rebalanceFreq}M`],
    ["Starts",    form.startingDate || "—"],
    ["Price Cap", form.priceCap ? `₹${Number(form.priceCap).toLocaleString("en-IN")}` : "None"],
  ];

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        .dp-root {
          min-height: calc(100vh - 60px);
          background: #f2f2f2;
          padding: 28px 28px 72px;
          font-family: ${SYS};
        }
        .dp-wrap {
          max-width: 1180px; margin: 0 auto;
          opacity: 0; transform: translateY(10px);
          transition: opacity 0.35s ease, transform 0.35s ease;
        }
        .dp-wrap.mounted { opacity: 1; transform: translateY(0); }

        .dp-layout {
          display: grid;
          grid-template-columns: 1fr 296px;
          gap: 14px;
          align-items: start;
        }
        @media (max-width: 840px) {
          .dp-layout { grid-template-columns: 1fr; }
          .dp-root { padding: 16px 14px 60px; }
        }

        .dp-side { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 14px; }

        .dp-g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .dp-g4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
        @media (max-width: 540px) {
          .dp-g2 { grid-template-columns: 1fr; }
          .dp-g4 { grid-template-columns: repeat(2, 1fr); }
        }

        .uni-opt { padding: 11px 8px; border-radius: 6px; cursor: pointer; border: 1.5px solid #ddd; background: #fff; text-align: center; transition: border-color 0.13s; user-select: none; }
        .uni-opt:hover { border-color: #999; }
        .uni-opt.sel  { border-color: #222; background: #f0f0f0; }
        .uni-name { font-size: 13px; font-weight: 700; color: #111; margin-bottom: 2px; }
        .uni-desc { font-size: 10px; color: #777; }

        .rtoggle { display: flex; border: 1px solid #ddd; border-radius: 6px; overflow: hidden; background: #f5f5f5; margin-bottom: 14px; }
        .rtbtn { flex: 1; padding: 9px 12px; font-size: 12px; font-weight: 600; border: none; cursor: pointer; background: transparent; color: #555; text-transform: uppercase; letter-spacing: 0.03em; transition: all 0.14s; display: flex; align-items: center; justify-content: center; gap: 5px; }
        .rtbtn:first-child { border-right: 1px solid #ddd; }
        .rtbtn.on { background: #222; color: #fff; }

        .dp-hint { display: flex; align-items: flex-start; gap: 7px; background: #eef2ff; border: 1px solid #c5d0f0; border-radius: 6px; padding: 9px 11px; margin-top: 10px; font-size: 12px; color: #333; line-height: 1.5; }

        .dp-summary { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px 16px; }
        .dp-summary-title { font-size: 11px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 12px; }
        .dp-sgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .dp-sk { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1px; }
        .dp-sv { font-size: 13px; font-weight: 700; color: #111; font-family: ${MONO}; }

        .dp-btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 4px; }
        .dp-btn { padding: 13px 16px; border-radius: 7px; font-size: 13px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; cursor: pointer; border: none; display: flex; align-items: center; justify-content: center; gap: 7px; transition: all 0.15s; font-family: ${SYS}; }
        .dp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .dp-btn-outline { background: #fff; color: #333; border: 1.5px solid #ccc; }
        .dp-btn-outline:hover:not(:disabled) { background: #f5f5f5; border-color: #888; }
        .dp-btn-solid   { background: #222; color: #fff; }
        .dp-btn-solid:hover:not(:disabled) { background: #3a3a3a; }

        .dots { display: flex; gap: 3px; align-items: center; }
        .dots span { width: 4px; height: 4px; border-radius: 50%; background: currentColor; animation: dot 0.9s ease-in-out infinite; }
        .dots span:nth-child(2) { animation-delay: 0.15s; }
        .dots span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes dot { 0%,80%,100%{transform:scale(1);opacity:0.5} 40%{transform:scale(1.4);opacity:1} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
        .fade-up { animation: fadeUp 0.2s ease; }
      `}</style>

      {showDateModal && (
        <BacktestDateModal
          onConfirm={runBacktest}
          onCancel={() => setShowDateModal(false)}
        />
      )}

      <div className="dp-root">
        <div className={`dp-wrap ${mounted ? "mounted" : ""}`}>

          {/* Header */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#777", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Strategy Configuration</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#111", marginBottom: 3 }}>Deploy Strategy</div>
            <div style={{ fontSize: 13, color: "#555", lineHeight: 1.5 }}>Configure your momentum strategy parameters before backtesting or going live.</div>
          </div>

          <div className="dp-layout">

            {/* ── LEFT: form ─────────────────────────────────────────── */}
            <div>
              {/* 01 Universe */}
              <Section number="1" title="Stock Universe">
                <Label hint="— pool of stocks the strategy selects from">Universe</Label>
                <div className="dp-g4" style={{ marginTop: 6 }}>
                  {UNIVERSE_OPTIONS.map(opt => (
                    <div key={opt.value} className={`uni-opt ${form.universe === opt.value ? "sel" : ""}`}
                      onClick={() => { setForm(f => ({ ...f, universe: opt.value })); setErrors(e => ({ ...e, universe: undefined })); }}>
                      <div className="uni-name">{opt.label}</div>
                      <div className="uni-desc">{opt.desc}</div>
                    </div>
                  ))}
                </div>
                <FieldError msg={errors.universe} />
              </Section>

              {/* 02 Portfolio Parameters */}
              <Section number="2" title="Portfolio Parameters">
                <div className="dp-g2">
                  <div>
                    <Label hint="— stocks held at any time">No. of Stocks</Label>
                    <Input value={form.numStocks} onChange={set("numStocks")} placeholder="e.g. 10" suffix="stocks" error={errors.numStocks} />
                    <FieldError msg={errors.numStocks} />
                  </div>
                  <div>
                    <Label hint="— optional max price filter">Stock Price Cap</Label>
                    <Input value={form.priceCap} onChange={set("priceCap")} placeholder="No limit" prefix="₹" />
                  </div>
                </div>
              </Section>

              {/* 03 Lookback Periods */}
              <Section number="3" title="Lookback Periods">
                <div className="dp-g2">
                  <div>
                    <Label hint="— primary return window">Period 1</Label>
                    <Select value={form.lookback1} onChange={set("lookback1")} options={LOOKBACK_OPTIONS.map(n => ({ value: n, label: `${n} month${n > 1 ? "s" : ""}` }))} error={errors.lookback1} />
                    <FieldError msg={errors.lookback1} />
                  </div>
                  <div>
                    <Label hint="— secondary return window">Period 2</Label>
                    <Select value={form.lookback2} onChange={set("lookback2")} options={LOOKBACK_OPTIONS.map(n => ({ value: n, label: `${n} month${n > 1 ? "s" : ""}` }))} error={errors.lookback2} />
                    <FieldError msg={errors.lookback2} />
                  </div>
                </div>
                <div className="dp-hint">
                  <span style={{ color: "#3b5bdb", flexShrink: 0 }}>ℹ</span>
                  Two different windows (e.g. <strong>6M + 12M</strong>) reduce signal noise and improve rank stability.
                </div>
              </Section>

              {/* 04 Capital & Rebalancing */}
              <Section number="4" title="Capital & Rebalancing">
                <div style={{ marginBottom: 16 }}>
                  <Label hint="— total amount to deploy">Capital</Label>
                  <Input value={form.capital} onChange={set("capital")} placeholder="e.g. 500000" prefix="₹" error={errors.capital} />
                  <FieldError msg={errors.capital} />
                </div>
                <Label hint="— schedule cadence">Rebalance Type</Label>
                <div className="rtoggle">
                  <button className={`rtbtn ${!isWeekly ? "on" : ""}`} onClick={() => setRebalanceType("monthly")}>📅 Monthly</button>
                  <button className={`rtbtn ${isWeekly ? "on" : ""}`}  onClick={() => setRebalanceType("weekly")}>⚡ Weekly</button>
                </div>
                <div key={isWeekly ? "w" : "m"} className="fade-up">
                  <div className="dp-g2">
                    <div>
                      <Label hint={isWeekly ? "— 1 to 52 weeks" : "— 1 to 12 months"}>Frequency</Label>
                      <Select value={form.rebalanceFreq} onChange={set("rebalanceFreq")}
                        options={(isWeekly ? WEEKLY_FREQ_OPTIONS : MONTHLY_FREQ_OPTIONS).map(n => ({
                          value: n, label: isWeekly ? `Every ${n} week${n > 1 ? "s" : ""}` : `Every ${n} month${n > 1 ? "s" : ""}`,
                        }))} />
                    </div>
                    <div>
                      <Label hint="— first rebalance date">Starting Date</Label>
                      <div style={{ border: "1.5px solid #ccc", borderRadius: 6, background: "#fff" }}>
                        <input type="date" value={form.startingDate} onChange={set("startingDate")} min={TODAY}
                          style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: 13, color: "#111", padding: "9px 11px", cursor: "pointer", fontFamily: SYS }} />
                      </div>
                    </div>
                  </div>
                  <div className="dp-hint">
                    <span style={{ color: "#3b5bdb", flexShrink: 0 }}>ℹ</span>
                    Starts <strong>{form.startingDate || "—"}</strong>, rebalances every <strong>{form.rebalanceFreq} {isWeekly ? `week${form.rebalanceFreq > 1 ? "s" : ""}` : `month${form.rebalanceFreq > 1 ? "s" : ""}`}</strong>.
                    {isWeekly ? " Higher frequency increases turnover costs." : " Lower frequency reduces transaction costs."}
                  </div>
                </div>
              </Section>

              {/* Buttons */}
              <div className="dp-btn-row">
                <button className="dp-btn dp-btn-outline" onClick={handleBacktestClick} disabled={anyLoading}>
                  {btLoading ? <><span>Running</span><div className="dots"><span/><span/><span/></div></> : <><span>⟳</span> Backtest</>}
                </button>
                <button className="dp-btn dp-btn-solid" onClick={handleDeploy} disabled={anyLoading}>
                  {depLoading ? <><span>Deploying</span><div className="dots"><span/><span/><span/></div></> : <><span>▶</span> Deploy Live</>}
                </button>
              </div>
            </div>

            {/* ── RIGHT: sticky sidebar ─────────────────────────────── */}
            <div className="dp-side">
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

          {/* Backtest Results — full width below */}
          <div ref={resultRef}>
            {backtestResult && backtestConfig && (
              <BacktestResult result={backtestResult} config={backtestConfig} visible={resultVisible} />
            )}
          </div>

        </div>
      </div>
    </>
  );
}