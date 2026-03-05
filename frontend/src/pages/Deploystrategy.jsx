import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart, Area, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─────────────────────────────────────────────────────────────────────────────
// API CONFIGURATION
// Replace these with your actual backend endpoints.
// All API calls are routed through `strategyService` below.
// ─────────────────────────────────────────────────────────────────────────────
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// API Endpoints — update paths to match your backend routes
const API_ENDPOINTS = {
  backtest: `${API_BASE_URL}/api/strategy/backtest`,   // POST
  deploy:   `${API_BASE_URL}/api/strategy/deploy`,     // POST
};

// ─────────────────────────────────────────────────────────────────────────────
// ███████╗████████╗ █████╗ ████████╗██╗ ██████╗    ██████╗  █████╗ ████████╗ █████╗
// ██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██║██╔════╝    ██╔══██╗██╔══██╗╚══██╔══╝██╔══██╗
// ███████╗   ██║   ███████║   ██║   ██║██║         ██║  ██║███████║   ██║   ███████║
// ╚════██║   ██║   ██╔══██║   ██║   ██║██║         ██║  ██║██╔══██║   ██║   ██╔══██║
// ███████║   ██║   ██║  ██║   ██║   ██║╚██████╗    ██████╔╝██║  ██║   ██║   ██║  ██║
// ╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝ ╚═════╝    ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝
//
// ⚠️  REMOVE THIS ENTIRE SECTION WHEN BACKEND IS CONNECTED  ⚠️
//
// This block contains:
//   1. generateMockBacktest()  — fake data generator replacing real backtest API
//   2. Mock delays in strategyService — replace with real fetch() calls below
//
// HOW TO REMOVE:
//   - Delete everything between the START and END markers below
//   - Uncomment the real fetch() implementations in strategyService
// ─────────────────────────────────────────────────────────────────────────────

// ── STATIC DATA START ────────────────────────────────────────────────────────

function generateMockBacktest(config) {
  const capital    = Number(config.capital);
  const startDate  = new Date(`${config.backtestStartYear}-01-01`);
  const endDate    = new Date();

  const series = [];
  let pv = capital, cash = capital * 0.05, invested = capital * 0.95;
  let peak = pv, maxDd = 0;
  const dailyRets = [];
  let d = new Date(startDate);

  while (d <= endDate) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      const drift = 0.00068;
      const noise = 0.011 * (Math.random() * 2 - 1);
      const ret   = drift + noise;
      invested   *= (1 + ret);
      cash       *= 0.9998;
      pv          = invested + cash;
      if (pv > peak) peak = pv;
      const dd = (pv - peak) / peak;
      if (dd < maxDd) maxDd = dd;
      dailyRets.push(ret);
      series.push({
        date:     d.toISOString().split("T")[0],
        pv:       +pv.toFixed(2),
        cash:     +cash.toFixed(2),
        invested: +invested.toFixed(2),
        drawdown: +(dd * 100).toFixed(3),
        holdings: config.numStocks - (Math.random() < 0.3 ? 1 : 0),
        rollingSharpe: null,
      });
    }
    d.setDate(d.getDate() + 1);
  }

  const W = 252;
  series.forEach((pt, i) => {
    if (i < W) return;
    const sl   = dailyRets.slice(i - W, i);
    const mean = sl.reduce((a, b) => a + b, 0) / W;
    const std  = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / W);
    pt.rollingSharpe = std > 0 ? +(mean / std * Math.sqrt(252)).toFixed(3) : null;
  });

  const yearMap = {};
  series.forEach(pt => {
    const yr = pt.date.slice(0, 4);
    if (!yearMap[yr]) yearMap[yr] = { start: pt.pv, end: pt.pv };
    yearMap[yr].end = pt.pv;
  });
  const yearlyReturns = Object.entries(yearMap).map(([year, { start, end }]) => ({
    year, ret: +((end - start) / start * 100).toFixed(2),
  }));

  const years   = (endDate - startDate) / (365.25 * 86400000);
  const totRet  = (pv - capital) / capital;
  const cagr    = Math.pow(1 + totRet, 1 / Math.max(years, 0.1)) - 1;
  const mean    = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
  const std     = Math.sqrt(dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyRets.length);
  const vol     = std * Math.sqrt(252);
  const sharpe  = (cagr - 0.065) / vol;
  const calmar  = Math.abs(maxDd) > 0 ? cagr / Math.abs(maxDd) : 0;
  const winRate = dailyRets.filter(r => r > 0).length / dailyRets.length;
  const avgCash = series.reduce((a, b) => a + b.cash / b.pv, 0) / series.length;

  const lakh = 1e5;
  const thin = series.filter((_, i) => i % 5 === 0).map(pt => ({
    ...pt,
    pvL:       +(pt.pv       / lakh).toFixed(3),
    cashL:     +(pt.cash     / lakh).toFixed(3),
    investedL: +(pt.invested / lakh).toFixed(3),
  }));

  return {
    series: thin,
    yearlyReturns,
    stats: {
      universe:    config.universe.toUpperCase(),
      initialCap:  capital,
      finalValue:  +pv.toFixed(2),
      totalReturn: totRet,
      cagr,
      vol,
      sharpe:      +sharpe.toFixed(2),
      maxDrawdown: maxDd,
      calmar:      +calmar.toFixed(2),
      winRate,
      bestDay:     Math.max(...dailyRets),
      worstDay:    Math.min(...dailyRets),
      avgCashDrag: avgCash,
    },
  };
}

// ── STATIC DATA END ──────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// API SERVICE
// Currently uses mock data. When backend is ready:
//   1. Delete generateMockBacktest() above (STATIC DATA section)
//   2. Uncomment the real fetch() blocks below
//   3. Remove the mock `await new Promise(...)` delay lines
//
// Expected API contract:
//   POST /api/strategy/backtest
//     Body: { universe, numStocks, lookback1, lookback2, priceCap, capital,
//             rebalanceType, rebalanceFreq, startingDate, backtestStartYear }
//     Response: { series: [...], yearlyReturns: [...], stats: { ... } }
//
//   POST /api/strategy/deploy
//     Body: { universe, numStocks, lookback1, lookback2, priceCap, capital,
//             rebalanceType, rebalanceFreq, startingDate }
//     Response: { success: true, strategyId: "..." }
// ─────────────────────────────────────────────────────────────────────────────
const strategyService = {
  backtest: async (config) => {
    // ── REMOVE when backend is ready ──────────────────────────────────────────
    await new Promise(r => setTimeout(r, 2000)); // fake network delay
    return generateMockBacktest(config);          // fake response
    // ── END REMOVE ────────────────────────────────────────────────────────────

    // ── UNCOMMENT when backend is ready ───────────────────────────────────────
    // const res = await fetch(API_ENDPOINTS.backtest, {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify(config),
    // });
    // if (!res.ok) throw new Error(`Backtest failed: ${res.statusText}`);
    // return res.json();
    // ── END UNCOMMENT ─────────────────────────────────────────────────────────
  },

  deploy: async (config) => {
    // ── REMOVE when backend is ready ──────────────────────────────────────────
    await new Promise(r => setTimeout(r, 1800)); // fake network delay
    return { success: true };                     // fake response
    // ── END REMOVE ────────────────────────────────────────────────────────────

    // ── UNCOMMENT when backend is ready ───────────────────────────────────────
    // const res = await fetch(API_ENDPOINTS.deploy, {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify(config),
    // });
    // if (!res.ok) throw new Error(`Deploy failed: ${res.statusText}`);
    // return res.json();
    // ── END UNCOMMENT ─────────────────────────────────────────────────────────
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// These are UI-level constants (dropdown options, defaults).
// Universe options may need to be fetched from backend if they become dynamic.
// ─────────────────────────────────────────────────────────────────────────────
const UNIVERSE_OPTIONS     = [
  { value: "nifty50",  label: "Nifty 50",  desc: "Large cap · 50 stocks"    },
  { value: "nifty100", label: "Nifty 100", desc: "Large cap · 100 stocks"   },
  { value: "nifty150", label: "Nifty 150", desc: "Large + Mid · 150 stocks" },
  { value: "nifty250", label: "Nifty 250", desc: "Large + Mid · 250 stocks" },
];
const LOOKBACK_OPTIONS     = Array.from({ length: 12 }, (_, i) => i + 1);
const MONTHLY_FREQ_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);
const WEEKLY_FREQ_OPTIONS  = Array.from({ length: 52 }, (_, i) => i + 1);
const TODAY                = new Date().toISOString().split("T")[0];
const CURRENT_YEAR         = new Date().getFullYear();
const BACKTEST_YEAR_OPTIONS = Array.from({ length: CURRENT_YEAR - 2002 }, (_, i) => 2003 + i);

const DEFAULT_FORM = {
  universe: "nifty50", numStocks: 10,
  lookback1: 6, lookback2: 12,
  priceCap: "", capital: "",
  rebalanceType: "monthly", rebalanceFreq: 1, startingDate: TODAY,
  backtestStartYear: 2015,
};

function validate(form) {
  const e = {};
  if (!form.universe)                                e.universe  = "Select a universe";
  if (!form.numStocks || form.numStocks < 1)         e.numStocks = "Min 1 stock";
  if (form.lookback1 === form.lookback2)              e.lookback2 = "Must differ from Period 1";
  if (!form.capital || Number(form.capital) < 10000) e.capital   = "Min ₹10,000";
  return e;
}

const fmt  = v => `${(v * 100).toFixed(2)}%`;
const fmtN = (v, d = 2) => v.toFixed(d);
const fmtC = v => `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

// ─────────────────────────────────────────────────────────────────────────────
// UI PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
function FieldLabel({ label, hint }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255)" }}>{label}</span>
      {hint && <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "rgba(255,255,255,0.38)", marginLeft: 8 }}>— {hint}</span>}
    </div>
  );
}

function FieldError({ msg }) {
  if (!msg) return null;
  return <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "#ff6b85", marginTop: 6 }}>⚠ {msg}</div>;
}

function StyledInput({ value, onChange, placeholder, prefix, suffix, error }) {
  const [f, setF] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,0.04)", border: `1px solid ${error ? "rgba(255,77,109,0.5)" : f ? "rgba(0,229,160,0.5)" : "rgba(255,255,255,0.13)"}`, borderRadius: 8, boxShadow: f ? "0 0 0 3px rgba(0,229,160,0.09)" : "none", transition: "all 0.18s" }}>
      {prefix && <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: "rgba(255,255,255,0.5)", padding: "0 0 0 14px" }}>{prefix}</span>}
      <input type="number" value={value} onChange={onChange} placeholder={placeholder} min="1"
        onFocus={() => setF(true)} onBlur={() => setF(false)}
        style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontFamily: "'JetBrains Mono',monospace", fontSize: 14, color: "#fff", padding: prefix ? "12px 14px 12px 8px" : "12px 14px", letterSpacing: "0.03em" }} />
      {suffix && <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "rgba(255,255,255,0.45)", padding: "0 14px 0 0" }}>{suffix}</span>}
    </div>
  );
}

function SelectInput({ value, onChange, options, error }) {
  const [f, setF] = useState(false);
  return (
    <div style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${error ? "rgba(255,77,109,0.5)" : f ? "rgba(0,229,160,0.5)" : "rgba(255,255,255,0.13)"}`, borderRadius: 8, position: "relative", boxShadow: f ? "0 0 0 3px rgba(0,229,160,0.09)" : "none", transition: "all 0.18s" }}>
      <select value={value} onChange={onChange} onFocus={() => setF(true)} onBlur={() => setF(false)}
        style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: "#fff", padding: "12px 36px 12px 14px", appearance: "none", cursor: "pointer" }}>
        {options.map(o => (
          <option key={o.value ?? o} value={o.value ?? o} style={{ background: "#0d1526", color: "#fff" }}>{o.label ?? o}</option>
        ))}
      </select>
      <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.5)", fontSize: 10, pointerEvents: "none" }}>▼</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKTEST YEAR MODAL
// ─────────────────────────────────────────────────────────────────────────────
function BacktestYearModal({ initialYear, onConfirm, onCancel }) {
  const [year, setYear] = useState(initialYear);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.82)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#080e1c", border: "1px solid rgba(0,229,160,0.2)", borderRadius: 18, padding: "32px 32px 28px", width: "100%", maxWidth: 460, boxShadow: "0 0 80px rgba(0,229,160,0.07), 0 24px 60px rgba(0,0,0,0.7)", position: "relative" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, background: "linear-gradient(90deg, transparent, rgba(0,229,160,0.45), transparent)", borderRadius: "18px 18px 0 0" }} />

        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: "0.2em", color: "rgba(0,229,160,0.7)", textTransform: "uppercase", marginBottom: 8 }}>// Configure Backtest</div>
        <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 24, fontWeight: 800, color: "#fff", marginBottom: 6 }}>Select Starting Year</div>
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: "rgba(255,255,255,0.48)", lineHeight: 1.7, marginBottom: 28 }}>
          Backtest will simulate the strategy from Jan 1 of the selected year through today. Longer periods yield more statistically robust results.
        </div>

        {/* Year grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 7, marginBottom: 20 }}>
          {BACKTEST_YEAR_OPTIONS.map(y => (
            <div key={y} onClick={() => setYear(y)} style={{
              padding: "10px 4px", textAlign: "center", borderRadius: 8, cursor: "pointer",
              border: `1px solid ${year === y ? "rgba(0,229,160,0.6)" : "rgba(255,255,255,0.1)"}`,
              background: year === y ? "rgba(0,229,160,0.13)" : "rgba(255,255,255,0.03)",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 12, fontWeight: year === y ? 700 : 400,
              color: year === y ? "#00e5a0" : "rgba(255,255,255,0.6)",
              transition: "all 0.14s", userSelect: "none",
            }}>{y}</div>
          ))}
        </div>

        {/* Info strip */}
        <div style={{ background: "rgba(0,229,160,0.06)", border: "1px solid rgba(0,229,160,0.15)", borderRadius: 8, padding: "10px 14px", marginBottom: 24, fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: "rgba(255,255,255,0.55)", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ color: "rgba(0,229,160,0.75)" }}>◈</span>
          From <span style={{ color: "#00e5a0", margin: "0 4px", fontWeight: 700 }}>{year}</span> → <span style={{ color: "#00e5a0", margin: "0 4px", fontWeight: 700 }}>{CURRENT_YEAR}</span> · ~<span style={{ color: "#00e5a0", margin: "0 4px", fontWeight: 700 }}>{CURRENT_YEAR - year} years</span> of data
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "13px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.05)", fontFamily: "'Syne',sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.65)", cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(year)} style={{ flex: 2, padding: "13px", borderRadius: 9, border: "none", background: "linear-gradient(135deg, #00e5a0, #00c98c)", fontFamily: "'Syne',sans-serif", fontSize: 12, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "#060a12", cursor: "pointer", boxShadow: "0 4px 24px rgba(0,229,160,0.3)" }}>
            ⟳ Run Backtest
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHART TOOLTIP
// ─────────────────────────────────────────────────────────────────────────────
function ChartTip({ active, payload, label, suffix = "", decimals = 2 }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#080e1c", border: "1px solid rgba(0,229,160,0.25)", borderRadius: 8, padding: "8px 12px", fontSize: 0 }}>
      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "rgba(255,255,255,0.55)", marginBottom: 5 }}>{label}</div>
      {payload.map((p, i) => p.value != null && (
        <div key={i} style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: p.color || "#00e5a0", marginBottom: 2 }}>
          {p.name}: {typeof p.value === "number" ? p.value.toFixed(decimals) : p.value}{suffix}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATS TABLE
// Receives data from API response (result.stats). No changes needed for backend.
// ─────────────────────────────────────────────────────────────────────────────
function StatsTable({ stats, startYear }) {
  const rows = [
    { label: "Universe",         value: stats.universe },
    { label: "Backtest Period",  value: `${startYear} – ${CURRENT_YEAR}` },
    { label: "Initial Capital",  value: fmtC(stats.initialCap) },
    { label: "Final Value",      value: fmtC(stats.finalValue),     color: "#00e5a0" },
    null,
    { label: "Total Return",     value: fmt(stats.totalReturn),     color: stats.totalReturn >= 0 ? "#00e5a0" : "#ff6b85" },
    { label: "CAGR",             value: fmt(stats.cagr),            color: stats.cagr >= 0 ? "#00e5a0" : "#ff6b85" },
    { label: "Ann. Volatility",  value: fmt(stats.vol) },
    { label: "Sharpe Ratio",     value: fmtN(stats.sharpe),         color: stats.sharpe >= 1 ? "#00e5a0" : stats.sharpe >= 0 ? "#f5c842" : "#ff6b85" },
    { label: "Max Drawdown",     value: fmt(stats.maxDrawdown),     color: "#ff6b85" },
    { label: "Calmar Ratio",     value: fmtN(stats.calmar),         color: stats.calmar >= 0.5 ? "#00e5a0" : "#f5c842" },
    null,
    { label: "Win Rate (Daily)", value: fmt(stats.winRate) },
    { label: "Best Day",         value: fmt(stats.bestDay),         color: "#00e5a0" },
    { label: "Worst Day",        value: fmt(stats.worstDay),        color: "#ff6b85" },
    { label: "Avg Cash Drag",    value: fmt(stats.avgCashDrag) },
  ];

  return (
    <div style={{ background: "rgba(10,16,30,0.9)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "13px 20px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#00e5a0", background: "rgba(0,229,160,0.12)", padding: "2px 8px", borderRadius: 4, letterSpacing: "0.06em" }}>STATS</span>
        <span style={{ fontFamily: "'Syne',sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)" }}>Performance Summary</span>
      </div>
      <div style={{ padding: "6px 0" }}>
        {rows.map((row, i) =>
          row === null ? (
            <div key={`sep${i}`} style={{ height: 1, background: "rgba(255,255,255,0.07)", margin: "5px 20px" }} />
          ) : (
            <div key={row.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 20px", background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent" }}>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "rgba(255,255,255,0.55)", letterSpacing: "0.04em" }}>{row.label}</span>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, fontWeight: 600, color: row.color || "rgba(255,255,255,0.9)" }}>{row.value}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHART WRAPPER
// ─────────────────────────────────────────────────────────────────────────────
function ChartCard({ num, title, height = 190, children }) {
  return (
    <div style={{ background: "rgba(10,16,30,0.9)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, overflow: "hidden", marginBottom: 12, position: "relative" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, background: "linear-gradient(90deg, transparent, rgba(0,229,160,0.22), transparent)" }} />
      <div style={{ padding: "11px 18px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#00e5a0", background: "rgba(0,229,160,0.12)", padding: "2px 8px", borderRadius: 4 }}>{num}</span>
        <span style={{ fontFamily: "'Syne',sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)" }}>{title}</span>
      </div>
      <div style={{ padding: "12px 6px 8px", height }}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKTEST RESULT
// Renders charts from API response. result shape must match:
//   { series: [...], stats: { ... } }
// ─────────────────────────────────────────────────────────────────────────────
function BacktestResult({ result, config, visible }) {
  const { series, stats } = result;

  const xProps = {
    dataKey: "date",
    tick: { fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fill: "rgba(255,255,255,0.45)" },
    tickFormatter: v => v ? v.slice(0, 4) : "",
    interval: Math.floor(series.length / 6),
    axisLine: { stroke: "rgba(255,255,255,0.08)" },
    tickLine: false,
  };
  const yStyle = { fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fill: "rgba(255,255,255,0.45)" };
  const grid   = { stroke: "rgba(255,255,255,0.05)", strokeDasharray: "3 3" };

  return (
    <div style={{ marginTop: 28, opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(20px)", transition: "opacity 0.5s ease, transform 0.5s cubic-bezier(0.16,1,0.3,1)" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00e5a0", boxShadow: "0 0 12px rgba(0,229,160,0.7)", animation: "bpulse 2s ease-in-out infinite" }} />
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: "0.18em", color: "rgba(0,229,160,0.75)", textTransform: "uppercase" }}>// Backtest Results · {config.backtestStartYear} – {CURRENT_YEAR}</span>
        <div style={{ flex: 1, height: 1, background: "linear-gradient(90deg, rgba(0,229,160,0.3), transparent)" }} />
      </div>

      {/* Stats table */}
      <StatsTable stats={stats} startYear={config.backtestStartYear} />

      <div style={{ height: 16 }} />

      {/* C1 — Equity Curve */}
      <ChartCard num="C1" title="Equity Curve — Invested vs Cash (₹ Lakhs)" height={200}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gInv" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#4C72B0" stopOpacity={0.85} />
                <stop offset="95%" stopColor="#4C72B0" stopOpacity={0.08} />
              </linearGradient>
              <linearGradient id="gCash" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#7aafc8" stopOpacity={0.55} />
                <stop offset="95%" stopColor="#7aafc8" stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis {...xProps} />
            <YAxis tick={yStyle} tickFormatter={v => `₹${v.toFixed(0)}L`} axisLine={false} tickLine={false} width={56} />
            <Tooltip content={<ChartTip suffix="L" decimals={2} />} />
            <Legend wrapperStyle={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "rgba(255,255,255,0.6)" }} />
            <Area type="monotone" dataKey="investedL" name="Invested" stackId="1" stroke="#4C72B0" fill="url(#gInv)" strokeWidth={1.5} dot={false} />
            <Area type="monotone" dataKey="cashL"     name="Cash"     stackId="1" stroke="#7aafc8" fill="url(#gCash)" strokeWidth={1} dot={false} />
            <Area type="monotone" dataKey="pvL"       name="Total NAV" stroke="#00e5a0" fill="none" strokeWidth={2.2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* C2 — Drawdown */}
      <ChartCard num="C2" title="Drawdown from Peak" height={155}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gDd" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#d62728" stopOpacity={0.75} />
                <stop offset="95%" stopColor="#d62728" stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis {...xProps} />
            <YAxis tick={yStyle} tickFormatter={v => `${v.toFixed(1)}%`} axisLine={false} tickLine={false} width={46} />
            <Tooltip content={<ChartTip suffix="%" decimals={2} />} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" />
            <Area type="monotone" dataKey="drawdown" name="Drawdown" stroke="#d62728" fill="url(#gDd)" strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* C3 — Rolling Sharpe */}
      <ChartCard num="C3" title="Rolling 1-Year Sharpe Ratio" height={155}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid {...grid} />
            <XAxis {...xProps} />
            <YAxis tick={yStyle} tickFormatter={v => v.toFixed(1)} axisLine={false} tickLine={false} width={36} />
            <Tooltip content={<ChartTip decimals={2} />} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 3" />
            <ReferenceLine y={1} stroke="rgba(0,229,160,0.28)" strokeDasharray="4 3" />
            <Line type="monotone" dataKey="rollingSharpe" name="Sharpe (1Y)" stroke="#2ca02c" strokeWidth={1.5} dot={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* C4 — Holdings */}
      <ChartCard num="C4" title="Number of Holdings" height={130}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gH" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#9467bd" stopOpacity={0.55} />
                <stop offset="95%" stopColor="#9467bd" stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis {...xProps} />
            <YAxis tick={yStyle} tickFormatter={v => Math.round(v)} axisLine={false} tickLine={false} width={28} domain={[0, config.numStocks + 3]} />
            <Tooltip content={<ChartTip decimals={0} />} />
            <Area type="stepAfter" dataKey="holdings" name="# Stocks" stroke="#9467bd" fill="url(#gH)" strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function DeployStrategy() {
  const navigate = useNavigate();
  const [form, setForm]             = useState(DEFAULT_FORM);
  const [errors, setErrors]         = useState({});
  const [btLoading, setBtLoading]   = useState(false);
  const [depLoading, setDepLoading] = useState(false);
  const [showYearModal, setShowYearModal] = useState(false);
  const [backtestResult, setBacktestResult] = useState(null);
  const [backtestConfig, setBacktestConfig] = useState(null);
  const [resultVisible, setResultVisible]   = useState(false);
  const [mounted, setMounted]       = useState(false);
  const resultRef = useRef(null);

  useEffect(() => { const t = setTimeout(() => setMounted(true), 40); return () => clearTimeout(t); }, []);

  const set = (key) => (e) => {
    const val = e.target.type === "number" ? Number(e.target.value) : e.target.value;
    setForm(f => ({ ...f, [key]: val }));
    setErrors(er => ({ ...er, [key]: undefined }));
  };
  const setRebalanceType = (type) => setForm(f => ({ ...f, rebalanceType: type, rebalanceFreq: 1, startingDate: TODAY }));

  const handleBacktestClick = () => {
    const errs = validate(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setShowYearModal(true);
  };

  // API call: POST /api/strategy/backtest
  const runBacktest = async (year) => {
    setShowYearModal(false);
    const config = { ...form, backtestStartYear: year };
    setBtLoading(true);
    setBacktestResult(null);
    setResultVisible(false);
    try {
      const result = await strategyService.backtest(config);
      setBacktestConfig(config);
      setBacktestResult(result);
      setTimeout(() => setResultVisible(true), 80);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 220);
    } catch (err) {
      // TODO: show error toast / notification to user
      console.error("Backtest error:", err);
    } finally {
      setBtLoading(false);
    }
  };

  // API call: POST /api/strategy/deploy
  // On success, navigate to dashboard. On failure, show error.
  const handleDeploy = async () => {
    const errs = validate(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setDepLoading(true);
    try {
      await strategyService.deploy(form);
      navigate("/dashboard");
    } catch (err) {
      // TODO: show error toast / notification to user
      console.error("Deploy error:", err);
    } finally {
      setDepLoading(false);
    }
  };

  const anyLoading = btLoading || depLoading;
  const isWeekly   = form.rebalanceType === "weekly";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .dp-root {
          min-height: calc(100vh - 60px);
          background: #060a12; padding: 40px 40px 80px;
          font-family: 'Syne', sans-serif; position: relative;
        }
        .dp-root::before {
          content: ''; position: fixed; inset: 0; pointer-events: none;
          background-image:
            linear-gradient(rgba(0,229,160,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,229,160,0.03) 1px, transparent 1px);
          background-size: 40px 40px;
        }
        .dp-wrap { max-width: 760px; margin: 0 auto; opacity: 0; transform: translateY(16px); transition: opacity 0.45s ease, transform 0.45s cubic-bezier(0.16,1,0.3,1); }
        .dp-wrap.mounted { opacity: 1; transform: translateY(0); }

        .dp-page-sub   { font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: 0.18em; color: rgba(0,229,160,0.75); text-transform: uppercase; margin-bottom: 6px; }
        .dp-page-title { font-size: 28px; font-weight: 800; color: #fff; margin-bottom: 6px; }
        .dp-page-desc  { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: rgba(255,255,255,0.48); letter-spacing: 0.04em; margin-bottom: 36px; line-height: 1.65; }

        .dp-card { background: rgba(10,16,30,0.88); border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; overflow: hidden; margin-bottom: 16px; position: relative; }
        .dp-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(0,229,160,0.25), transparent); }
        .dp-card-header { padding: 16px 24px; border-bottom: 1px solid rgba(255,255,255,0.07); display: flex; align-items: center; gap: 10px; }
        .dp-card-num   { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #00e5a0; background: rgba(0,229,160,0.12); padding: 2px 8px; border-radius: 4px; letter-spacing: 0.08em; }
        .dp-card-title { font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,0.75); }
        .dp-card-body  { padding: 22px 24px; }

        .dp-universe-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
        @media (max-width: 600px) { .dp-universe-grid { grid-template-columns: repeat(2, 1fr); } .dp-root { padding: 24px 20px 80px; } }
        .dp-universe-opt { padding: 14px 12px; border-radius: 10px; cursor: pointer; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); text-align: center; transition: all 0.18s; user-select: none; }
        .dp-universe-opt:hover { border-color: rgba(0,229,160,0.28); background: rgba(0,229,160,0.04); }
        .dp-universe-opt.selected { border-color: rgba(0,229,160,0.55); background: rgba(0,229,160,0.09); box-shadow: 0 0 0 2px rgba(0,229,160,0.1); }
        .dp-universe-label { font-size: 14px; font-weight: 700; color: #fff; margin-bottom: 4px; }
        .dp-universe-opt.selected .dp-universe-label { color: #00e5a0; }
        .dp-universe-desc { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: rgba(255,255,255,0.45); }

        .dp-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        @media (max-width: 520px) { .dp-grid-2 { grid-template-columns: 1fr; } }

        .dp-type-toggle { display: flex; border-radius: 10px; overflow: hidden; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); margin-bottom: 20px; }
        .dp-type-btn { flex: 1; padding: 12px 20px; font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; border: none; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; background: transparent; color: rgba(255,255,255,0.5); }
        .dp-type-btn:first-child { border-right: 1px solid rgba(255,255,255,0.08); }
        .dp-type-btn.active { background: rgba(0,229,160,0.1); color: #00e5a0; }

        .dp-freq-sub { animation: fadeSlideIn 0.25s ease forwards; }
        @keyframes fadeSlideIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }

        .dp-actions { display: flex; gap: 12px; margin-top: 28px; flex-wrap: wrap; }
        .dp-btn { flex: 1; min-width: 160px; font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 14px 20px; border-radius: 10px; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all 0.18s; }
        .dp-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .dp-btn-ghost { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.8); border: 1px solid rgba(255,255,255,0.15); }
        .dp-btn-ghost:hover:not(:disabled) { background: rgba(255,255,255,0.09); color: #fff; }
        .dp-btn-primary { background: linear-gradient(135deg, #00e5a0, #00c98c); color: #060a12; box-shadow: 0 4px 20px rgba(0,229,160,0.22); }
        .dp-btn-primary:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); box-shadow: 0 8px 28px rgba(0,229,160,0.3); }
        .dp-btn-primary:active:not(:disabled) { transform: translateY(0); }

        .dp-dots { display: flex; gap: 4px; align-items: center; }
        .dp-dots span { width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: dpDot 0.9s ease-in-out infinite; }
        .dp-dots span:nth-child(2) { animation-delay: 0.15s; }
        .dp-dots span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes dpDot { 0%,80%,100%{transform:scale(1);opacity:0.5} 40%{transform:scale(1.4);opacity:1} }

        .dp-info-strip { display: flex; align-items: flex-start; gap: 10px; background: rgba(0,229,160,0.05); border: 1px solid rgba(0,229,160,0.15); border-radius: 8px; padding: 12px 14px; margin-top: 16px; }
        .dp-info-icon  { font-size: 13px; color: rgba(0,229,160,0.75); flex-shrink: 0; margin-top: 1px; }
        .dp-info-text  { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: rgba(255,255,255,0.55); line-height: 1.65; }
        .dp-info-text strong { color: rgba(255,255,255,0.85); font-weight: 600; }

        .dp-summary-key { font-family: 'JetBrains Mono', monospace; font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.42); margin-bottom: 3px; }
        .dp-summary-val { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #00e5a0; font-weight: 500; }

        @keyframes bpulse {
          0%,100% { opacity:1; box-shadow:0 0 12px rgba(0,229,160,0.7) }
          50%      { opacity:0.5; box-shadow:0 0 4px rgba(0,229,160,0.2) }
        }
      `}</style>

      {showYearModal && (
        <BacktestYearModal
          initialYear={form.backtestStartYear}
          onConfirm={runBacktest}
          onCancel={() => setShowYearModal(false)}
        />
      )}

      <div className="dp-root">
        <div className={`dp-wrap ${mounted ? "mounted" : ""}`}>
          <div className="dp-page-sub">// Strategy Configuration</div>
          <div className="dp-page-title">Deploy Strategy</div>
          <div className="dp-page-desc">Configure your momentum strategy parameters before backtesting or going live.</div>

          {/* ── Section 01: Stock Universe ──────────────────────────────────── */}
          {/* API TODO: fetch universe list from GET /api/universes if dynamic   */}
          <div className="dp-card">
            <div className="dp-card-header"><span className="dp-card-num">01</span><span className="dp-card-title">Stock Universe</span></div>
            <div className="dp-card-body">
              <FieldLabel label="Universe" hint="pool of stocks the strategy selects from" />
              <div className="dp-universe-grid">
                {UNIVERSE_OPTIONS.map(opt => (
                  <div key={opt.value} className={`dp-universe-opt ${form.universe === opt.value ? "selected" : ""}`}
                    onClick={() => { setForm(f => ({ ...f, universe: opt.value })); setErrors(e => ({ ...e, universe: undefined })); }}>
                    <div className="dp-universe-label">{opt.label}</div>
                    <div className="dp-universe-desc">{opt.desc}</div>
                  </div>
                ))}
              </div>
              <FieldError msg={errors.universe} />
            </div>
          </div>

          {/* ── Section 02: Portfolio Parameters ───────────────────────────── */}
          <div className="dp-card">
            <div className="dp-card-header"><span className="dp-card-num">02</span><span className="dp-card-title">Portfolio Parameters</span></div>
            <div className="dp-card-body">
              <div className="dp-grid-2">
                <div>
                  <FieldLabel label="No. of Stocks" hint="stocks held at any time" />
                  <StyledInput value={form.numStocks} onChange={set("numStocks")} placeholder="e.g. 10" suffix="stocks" error={errors.numStocks} />
                  <FieldError msg={errors.numStocks} />
                </div>
                <div>
                  <FieldLabel label="Stock Price Cap" hint="optional max price filter" />
                  <StyledInput value={form.priceCap} onChange={set("priceCap")} placeholder="No limit" prefix="₹" />
                </div>
              </div>
            </div>
          </div>

          {/* ── Section 03: Lookback Periods ────────────────────────────────── */}
          <div className="dp-card">
            <div className="dp-card-header"><span className="dp-card-num">03</span><span className="dp-card-title">Lookback Periods</span></div>
            <div className="dp-card-body">
              <div className="dp-grid-2">
                <div>
                  <FieldLabel label="Period 1" hint="primary return window" />
                  <SelectInput value={form.lookback1} onChange={set("lookback1")} options={LOOKBACK_OPTIONS.map(n => ({ value: n, label: `${n} month${n > 1 ? "s" : ""}` }))} error={errors.lookback1} />
                  <FieldError msg={errors.lookback1} />
                </div>
                <div>
                  <FieldLabel label="Period 2" hint="secondary return window" />
                  <SelectInput value={form.lookback2} onChange={set("lookback2")} options={LOOKBACK_OPTIONS.map(n => ({ value: n, label: `${n} month${n > 1 ? "s" : ""}` }))} error={errors.lookback2} />
                  <FieldError msg={errors.lookback2} />
                </div>
              </div>
              <div className="dp-info-strip">
                <span className="dp-info-icon">ℹ</span>
                <div className="dp-info-text">Two different windows (e.g. <strong>6M + 12M</strong>) reduce signal noise and improve rank stability.</div>
              </div>
            </div>
          </div>

          {/* ── Section 04: Capital & Rebalancing ──────────────────────────── */}
          <div className="dp-card">
            <div className="dp-card-header"><span className="dp-card-num">04</span><span className="dp-card-title">Capital & Rebalancing</span></div>
            <div className="dp-card-body">
              <div style={{ marginBottom: 24 }}>
                <FieldLabel label="Capital" hint="total amount to deploy" />
                <StyledInput value={form.capital} onChange={set("capital")} placeholder="e.g. 500000" prefix="₹" error={errors.capital} />
                <FieldError msg={errors.capital} />
              </div>
              <FieldLabel label="Rebalance Type" hint="schedule cadence" />
              <div className="dp-type-toggle">
                <button className={`dp-type-btn ${!isWeekly ? "active" : ""}`} onClick={() => setRebalanceType("monthly")}>📅 Monthly</button>
                <button className={`dp-type-btn ${isWeekly ? "active" : ""}`}  onClick={() => setRebalanceType("weekly")}>⚡ Weekly</button>
              </div>
              <div className="dp-freq-sub" key={isWeekly ? "w" : "m"}>
                <div className="dp-grid-2">
                  <div>
                    <FieldLabel label="Frequency" hint={isWeekly ? "every N weeks (1–52)" : "every N months (1–12)"} />
                    <SelectInput value={form.rebalanceFreq} onChange={set("rebalanceFreq")}
                      options={(isWeekly ? WEEKLY_FREQ_OPTIONS : MONTHLY_FREQ_OPTIONS).map(n => ({
                        value: n, label: isWeekly ? `Every ${n} week${n > 1 ? "s" : ""}` : `Every ${n} month${n > 1 ? "s" : ""}`,
                      }))} />
                  </div>
                  <div>
                    <FieldLabel label="Starting Date" hint="first rebalance date" />
                    <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.13)", borderRadius: 8 }}>
                      <input type="date" value={form.startingDate} onChange={set("startingDate")} min={TODAY}
                        style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: "#fff", padding: "11px 14px", cursor: "pointer", colorScheme: "dark" }} />
                    </div>
                  </div>
                </div>
                <div className="dp-info-strip">
                  <span className="dp-info-icon">ℹ</span>
                  <div className="dp-info-text">
                    Starts <strong>{form.startingDate || "—"}</strong>, rebalances every <strong>{form.rebalanceFreq} {isWeekly ? `week${form.rebalanceFreq > 1 ? "s" : ""}` : `month${form.rebalanceFreq > 1 ? "s" : ""}`}</strong>.
                    {isWeekly ? " Higher frequency increases turnover costs." : " Lower frequency reduces transaction costs."}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── Config Summary Strip ─────────────────────────────────────────── */}
          {form.capital && form.numStocks && (
            <div style={{ background: "rgba(0,229,160,0.05)", border: "1px solid rgba(0,229,160,0.13)", borderRadius: 10, padding: "14px 20px", display: "flex", gap: 24, flexWrap: "wrap" }}>
              {[
                ["Universe", UNIVERSE_OPTIONS.find(o => o.value === form.universe)?.label],
                ["Stocks",   form.numStocks],
                ["Lookback", `${form.lookback1}M + ${form.lookback2}M`],
                ["Capital",  `₹${Number(form.capital).toLocaleString("en-IN")}`],
                ["Type",     isWeekly ? "Weekly" : "Monthly"],
                ["Freq",     isWeekly ? `Every ${form.rebalanceFreq}W` : `Every ${form.rebalanceFreq}M`],
                ["Starts",   form.startingDate || "—"],
                ["Price Cap",form.priceCap ? `₹${Number(form.priceCap).toLocaleString("en-IN")}` : "None"],
              ].map(([k, v]) => (
                <div key={k}>
                  <div className="dp-summary-key">{k}</div>
                  <div className="dp-summary-val">{v}</div>
                </div>
              ))}
            </div>
          )}

          {/* ── Action Buttons ───────────────────────────────────────────────── */}
          {/* Backtest → POST /api/strategy/backtest                             */}
          {/* Deploy   → POST /api/strategy/deploy → navigate("/dashboard")     */}
          <div className="dp-actions">
            <button className="dp-btn dp-btn-ghost" onClick={handleBacktestClick} disabled={anyLoading}>
              {btLoading ? <><span>Running</span><div className="dp-dots"><span/><span/><span/></div></> : <><span>⟳</span> Backtest</>}
            </button>
            <button className="dp-btn dp-btn-primary" onClick={handleDeploy} disabled={anyLoading}>
              {depLoading ? <><span>Deploying</span><div className="dp-dots"><span/><span/><span/></div></> : <><span>▶</span> Deploy Live</>}
            </button>
          </div>

          {/* ── Backtest Results ─────────────────────────────────────────────── */}
          {/* Populated from strategyService.backtest() response               */}
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