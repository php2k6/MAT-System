import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart, Area, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─── API ──────────────────────────────────────────────────────────────────────
const BASE_URL = import.meta.env.VITE_API_BASE_URL;

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Always try to parse JSON; fall back to empty object
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Backend error shape: { detail: { success: false, message: "..." } }
    // Also handle flat { message } or { error } shapes for safety
    const msg =
      data?.detail?.message ||
      data?.detail ||
      data?.message ||
      data?.error ||
      res.statusText ||
      "Request failed";
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  return data;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TODAY    = new Date().toISOString().split("T")[0];
const MIN_DATE = "2016-01-01";

// startingDate must be at least tomorrow per deploy API rules
const TOMORROW = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
})();

const UNIVERSES = [
  { value: "nifty50",  label: "Nifty 50",  desc: "Large cap · 50 stocks"    },
  { value: "nifty100", label: "Nifty 100", desc: "Large cap · 100 stocks"   },
  { value: "nifty150", label: "Nifty 150", desc: "Large + Mid · 150 stocks" },
  { value: "nifty250", label: "Nifty 250", desc: "Large + Mid · 250 stocks" },
];

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const WEEKS  = Array.from({ length: 52 }, (_, i) => i + 1);

const DEFAULT_FORM = {
  universe:      "nifty50",
  numStocks:     10,
  lookback1:     6,
  lookback2:     12,
  priceCap:      "",
  capital:       "",
  rebalanceType: "monthly",
  rebalanceFreq: 1,
  startingDate:  TOMORROW,  // ≥ tomorrow required by deploy API
};

// ─── VALIDATION ───────────────────────────────────────────────────────────────
function validateForm(form) {
  const errors = {};
  if (!form.universe)
    errors.universe = "Select a universe";
  if (!form.numStocks || Number(form.numStocks) < 1)
    errors.numStocks = "Minimum 1 stock required";
  if (Number(form.lookback1) === Number(form.lookback2))
    errors.lookback2 = "Must differ from Period 1";
  if (!form.capital || Number(form.capital) < 10000)
    errors.capital = "Minimum ₹10,000 required";
  if (form.priceCap && Number(form.priceCap) <= 0)
    errors.priceCap = "Price cap must be positive";
  if (!form.startingDate)
    errors.startingDate = "Starting date is required";
  return errors;
}

// Deploy adds an extra constraint: startingDate must be ≥ tomorrow
function validateDeploy(form) {
  const errors = validateForm(form);
  if (form.startingDate && form.startingDate < TOMORROW)
    errors.startingDate = "Starting date must be at least tomorrow";
  return errors;
}

// ─── FORMATTERS ───────────────────────────────────────────────────────────────
const fmtPct   = v => (v !== null && v !== undefined) ? `${(Number(v) * 100).toFixed(2)}%` : "—";
const fmtNum   = (v, d = 2) => (v !== null && v !== undefined) ? Number(v).toFixed(d) : "—";
const fmtRupee = v => (v !== null && v !== undefined)
  ? `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
  : "—";

// ─── FONTS ────────────────────────────────────────────────────────────────────
const SYS  = `'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'JetBrains Mono', 'Fira Code', 'Courier New', Courier, monospace`;

// ─── SMALL REUSABLE COMPONENTS ────────────────────────────────────────────────

function Label({ children, hint }) {
  return (
    <div style={{ marginBottom: 6, display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#111", fontFamily: SYS }}>{children}</span>
      {hint && <span style={{ fontSize: 11, color: "#888", fontFamily: SYS }}>{hint}</span>}
    </div>
  );
}

function FieldError({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ fontSize: 11, color: "#c62828", marginTop: 4, fontWeight: 500, fontFamily: SYS, display: "flex", alignItems: "center", gap: 4 }}>
      <span>⚠</span> {msg}
    </div>
  );
}

function NumberInput({ value, onChange, placeholder, prefix, suffix, error, min, disabled }) {
  const [focused, setFocused] = useState(false);
  const borderColor = error ? "#c62828" : focused ? "#333" : "#d0d0d0";

  return (
    <div style={{
      display: "flex", alignItems: "center",
      border: `1.5px solid ${borderColor}`,
      borderRadius: 7, background: disabled ? "#f9f9f9" : "#fff",
      boxShadow: focused ? "0 0 0 3px rgba(0,0,0,0.06)" : "none",
      transition: "border-color 0.14s, box-shadow 0.14s",
    }}>
      {prefix && <span style={{ fontSize: 13, color: "#666", paddingLeft: 11, fontFamily: SYS, userSelect: "none" }}>{prefix}</span>}
      <input
        type="number"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        min={min}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1, border: "none", outline: "none",
          background: "transparent", fontSize: 14, color: "#111",
          padding: prefix ? "9px 11px 9px 5px" : "9px 11px",
          fontFamily: SYS, cursor: disabled ? "not-allowed" : "auto",
        }}
      />
      {suffix && <span style={{ fontSize: 11, color: "#999", paddingRight: 11, fontFamily: SYS, userSelect: "none" }}>{suffix}</span>}
    </div>
  );
}

function Dropdown({ value, onChange, options, error, disabled }) {
  const [focused, setFocused] = useState(false);
  const borderColor = error ? "#c62828" : focused ? "#333" : "#d0d0d0";

  return (
    <div style={{
      border: `1.5px solid ${borderColor}`, borderRadius: 7,
      background: disabled ? "#f9f9f9" : "#fff", position: "relative",
      boxShadow: focused ? "0 0 0 3px rgba(0,0,0,0.06)" : "none",
      transition: "border-color 0.14s, box-shadow 0.14s",
    }}>
      <select
        value={value}
        onChange={onChange}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: "100%", border: "none", outline: "none",
          background: "transparent", fontSize: 13, color: "#111",
          padding: "9px 32px 9px 11px", appearance: "none",
          cursor: disabled ? "not-allowed" : "pointer", fontFamily: SYS,
        }}
      >
        {options.map(o => (
          <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
        ))}
      </select>
      <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "#aaa", fontSize: 10, pointerEvents: "none" }}>▼</span>
    </div>
  );
}

function Section({ number, title, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden", marginBottom: 12, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
      <div style={{ padding: "11px 18px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", gap: 10, background: "#fafafa" }}>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: "#1a1a1a", color: "#fff", fontSize: 11, fontWeight: 700, fontFamily: MONO, display: "flex", alignItems: "center", justifyContent: "center" }}>{number}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#333", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: SYS }}>{title}</span>
      </div>
      <div style={{ padding: "16px 18px" }}>{children}</div>
    </div>
  );
}

function Hint({ children }) {
  return (
    <div style={{ display: "flex", gap: 7, background: "#f0f4ff", border: "1px solid #d0daff", borderRadius: 7, padding: "9px 11px", marginTop: 10, fontSize: 12, color: "#334", lineHeight: 1.55 }}>
      <span style={{ color: "#3b5bdb", flexShrink: 0 }}>ℹ</span>
      <span>{children}</span>
    </div>
  );
}

// ─── ALERT BANNER ─────────────────────────────────────────────────────────────
function AlertBanner({ type = "error", title, message, onDismiss }) {
  const styles = {
    error:   { bg: "#fff5f5", border: "#fca5a5", icon: "✕", titleColor: "#c62828", msgColor: "#7f1d1d" },
    success: { bg: "#f0fdf4", border: "#86efac", icon: "✓", titleColor: "#166534", msgColor: "#14532d" },
    warning: { bg: "#fffbeb", border: "#fcd34d", icon: "⚠", titleColor: "#92400e", msgColor: "#78350f" },
  };
  const s = styles[type] || styles.error;
  return (
    <div style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 8, padding: "12px 16px", marginTop: 12, display: "flex", justifyContent: "space-between", gap: 12, fontFamily: SYS }}>
      <div style={{ display: "flex", gap: 8 }}>
        <span style={{ color: s.titleColor, fontSize: 14, flexShrink: 0 }}>{s.icon}</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: s.titleColor, marginBottom: 2 }}>{title}</div>
          <div style={{ fontSize: 12, color: s.msgColor, lineHeight: 1.5 }}>{message}</div>
        </div>
      </div>
      <button onClick={onDismiss} style={{ background: "none", border: "none", cursor: "pointer", color: s.titleColor, fontSize: 20, lineHeight: 1, flexShrink: 0, padding: "0 2px" }}>×</button>
    </div>
  );
}

function LoadingDots() {
  return (
    <div className="dots">
      <span /><span /><span />
    </div>
  );
}

// ─── DEPLOY CONFIRM MODAL ─────────────────────────────────────────────────────
function DeployConfirmModal({ form, onConfirm, onCancel, loading }) {
  const isWeekly = form.rebalanceType === "weekly";
  const rows = [
    ["Universe",   UNIVERSES.find(u => u.value === form.universe)?.label || form.universe],
    ["Stocks",     `${form.numStocks} stocks`],
    ["Lookback",   `${form.lookback1}M + ${form.lookback2}M`],
    ["Capital",    fmtRupee(form.capital)],
    ["Rebalance",  isWeekly ? `Every ${form.rebalanceFreq} week(s)` : `Every ${form.rebalanceFreq} month(s)`],
    ["Starts",     form.startingDate],
    ["Price Cap",  form.priceCap ? fmtRupee(form.priceCap) : "None"],
  ];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: "28px 28px 24px", width: "100%", maxWidth: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.18)", fontFamily: SYS }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5 }}>Confirm Deployment</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#111", marginBottom: 6 }}>Deploy Strategy Live</div>
        <div style={{ fontSize: 13, color: "#666", lineHeight: 1.55, marginBottom: 20 }}>
          You are about to deploy this strategy with real capital. Please review the configuration below before confirming.
        </div>

        <div style={{ background: "#fafafa", border: "1px solid #eee", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
          {rows.map(([k, v], i) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", background: i % 2 === 0 ? "#fafafa" : "#f4f4f4" }}>
              <span style={{ fontSize: 12, color: "#666" }}>{k}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#111", fontFamily: MONO }}>{v}</span>
            </div>
          ))}
        </div>

        <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 7, padding: "10px 13px", marginBottom: 20, fontSize: 12, color: "#78350f", lineHeight: 1.5 }}>
          ⚠ Ensure your broker is connected and available balance exactly matches the capital entered.
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} disabled={loading} style={{ flex: 1, padding: 12, borderRadius: 7, border: "1px solid #ccc", background: "#fff", fontSize: 13, fontWeight: 600, color: "#444", cursor: loading ? "not-allowed" : "pointer", fontFamily: SYS }}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={loading} style={{ flex: 2, padding: 12, borderRadius: 7, border: "none", background: loading ? "#555" : "#1a1a1a", fontSize: 13, fontWeight: 700, color: "#fff", cursor: loading ? "not-allowed" : "pointer", fontFamily: SYS, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            {loading ? <><span>Deploying</span><LoadingDots /></> : "▶ Confirm & Deploy"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── BACKTEST DATE MODAL ──────────────────────────────────────────────────────
function BacktestDateModal({ onConfirm, onCancel }) {
  const [date, setDate] = useState("2016-01-01");

  const isValid = date && date >= MIN_DATE && date < TODAY;
  const years   = isValid ? ((new Date() - new Date(date)) / (365.25 * 86400000)).toFixed(1) : 0;

  const presets = [
    { label: "1 Year",     date: new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString().split("T")[0] },
    { label: "3 Years",    date: new Date(new Date().setFullYear(new Date().getFullYear() - 3)).toISOString().split("T")[0] },
    { label: "5 Years",    date: new Date(new Date().setFullYear(new Date().getFullYear() - 5)).toISOString().split("T")[0] },
    { label: "Since 2016", date: "2016-01-01" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: "28px 28px 24px", width: "100%", maxWidth: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.18)", fontFamily: SYS }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5 }}>Configure Backtest</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#111", marginBottom: 6 }}>Select Starting Date</div>
        <div style={{ fontSize: 13, color: "#666", lineHeight: 1.55, marginBottom: 22 }}>
          The backtest will simulate strategy performance from this date through today.
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#444", marginBottom: 6 }}>Backtest Start Date</div>
          <div style={{ border: `1.5px solid ${!isValid && date ? "#c62828" : "#d0d0d0"}`, borderRadius: 7, background: "#fff" }}>
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
            <div style={{ fontSize: 11, color: "#c62828", marginTop: 4, fontWeight: 500 }}>⚠ Data available from Jan 1, 2016 onwards</div>
          )}
          {date && date >= TODAY && (
            <div style={{ fontSize: 11, color: "#c62828", marginTop: 4, fontWeight: 500 }}>⚠ Start date must be before today</div>
          )}
        </div>

        {isValid && (
          <div style={{ background: "#f5f5f5", border: "1px solid #e5e5e5", borderRadius: 7, padding: "10px 14px", marginBottom: 20, display: "flex", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 10, color: "#999", textTransform: "uppercase", marginBottom: 2 }}>Backtest Period</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111", fontFamily: MONO }}>
                {new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} → Today
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#999", textTransform: "uppercase", marginBottom: 2 }}>Duration</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111", fontFamily: MONO }}>~{years} years</div>
            </div>
          </div>
        )}

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#999", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Quick Presets</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {presets.map(p => (
              <button
                key={p.label}
                onClick={() => setDate(p.date)}
                style={{
                  padding: "5px 11px", borderRadius: 6,
                  border: `1.5px solid ${date === p.date ? "#1a1a1a" : "#ddd"}`,
                  background: date === p.date ? "#1a1a1a" : "#fff",
                  fontSize: 11, fontWeight: 600,
                  color: date === p.date ? "#fff" : "#555",
                  cursor: "pointer", fontFamily: SYS, transition: "all 0.13s",
                }}
              >{p.label}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: 12, borderRadius: 7, border: "1px solid #ccc", background: "#fff", fontSize: 13, fontWeight: 600, color: "#444", cursor: "pointer", fontFamily: SYS }}>
            Cancel
          </button>
          <button
            onClick={() => isValid && onConfirm(date)}
            disabled={!isValid}
            style={{ flex: 2, padding: 12, borderRadius: 7, border: "none", background: isValid ? "#1a1a1a" : "#ccc", fontSize: 13, fontWeight: 700, color: "#fff", cursor: isValid ? "pointer" : "not-allowed", fontFamily: SYS }}
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
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 7, padding: "8px 12px", boxShadow: "0 4px 16px rgba(0,0,0,0.1)", fontFamily: SYS }}>
      <div style={{ fontSize: 10, color: "#999", marginBottom: 5, fontFamily: MONO }}>{label}</div>
      {payload.map((p, i) => p.value != null && (
        <div key={i} style={{ fontSize: 11, color: p.color || "#222", marginBottom: 2, fontFamily: MONO }}>
          {p.name}: <strong>{typeof p.value === "number" ? p.value.toFixed(decimals) : p.value}{suffix}</strong>
        </div>
      ))}
    </div>
  );
}

// ─── PERFORMANCE STATS TABLE ──────────────────────────────────────────────────
function StatsTable({ stats, startDate }) {
  const rows = [
    ["Universe",         stats.universe,                       null],
    ["Backtest Period",  `${startDate} → Today`,               null],
    ["Initial Capital",  fmtRupee(stats.initialCap),           null],
    ["Final Value",      fmtRupee(stats.finalValue),           "#1b6f3e"],
    null,
    ["Total Return",     fmtPct(stats.totalReturn),            stats.totalReturn >= 0 ? "#1b6f3e" : "#c62828"],
    ["CAGR",             fmtPct(stats.cagr),                   stats.cagr >= 0 ? "#1b6f3e" : "#c62828"],
    ["Ann. Volatility",  fmtPct(stats.vol),                    null],
    ["Sharpe Ratio",     fmtNum(stats.sharpe),                 stats.sharpe >= 1 ? "#1b6f3e" : stats.sharpe >= 0 ? "#9a5000" : "#c62828"],
    ["Max Drawdown",     fmtPct(stats.maxDrawdown),            "#c62828"],
    ["Calmar Ratio",     fmtNum(stats.calmar),                 stats.calmar >= 0.5 ? "#1b6f3e" : "#9a5000"],
    null,
    ["Win Rate (Daily)", fmtPct(stats.winRate),                null],
    ["Best Day",         fmtPct(stats.bestDay),                "#1b6f3e"],
    ["Worst Day",        fmtPct(stats.worstDay),               "#c62828"],
    ["Avg Cash Drag",    fmtPct(stats.avgCashDrag),            null],
  ];

  return (
    <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
      <div style={{ padding: "11px 16px", borderBottom: "1px solid #f0f0f0", background: "#fafafa" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#333", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: SYS }}>Performance Summary</span>
      </div>
      {rows.map((row, i) =>
        row === null
          ? <div key={`sep${i}`} style={{ height: 1, background: "#f0f0f0", margin: "0 16px" }} />
          : (
            <div key={row[0]} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 16px", background: i % 2 === 0 ? "#fafafa" : "#fff" }}>
              <span style={{ fontSize: 12, color: "#555", fontFamily: SYS }}>{row[0]}</span>
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
    <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden", marginBottom: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
      <div style={{ padding: "9px 16px", borderBottom: "1px solid #f0f0f0", background: "#fafafa", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: "#555", padding: "2px 8px", borderRadius: 4, fontFamily: MONO }}>{num}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#444", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: SYS }}>{title}</span>
      </div>
      <div style={{ padding: "10px 6px 6px", height }}>{children}</div>
    </div>
  );
}

// ─── BACKTEST RESULT CHARTS ───────────────────────────────────────────────────
function BacktestResult({ result, config, visible }) {
  const { stats } = result;

  // Backend sends drawdown as decimal (0 to -1); multiply by 100 for percentage display
  const series = result.series.map(d => ({
    ...d,
    drawdown: d.drawdown != null ? d.drawdown * 100 : null,
  }));

  const xAxis = {
    dataKey: "date",
    tick: { fontFamily: MONO, fontSize: 9, fill: "#aaa" },
    tickFormatter: v => v?.slice(0, 4),
    interval: Math.max(1, Math.floor(series.length / 6)),
    axisLine: { stroke: "#eee" },
    tickLine: false,
  };
  const yTick = { fontFamily: MONO, fontSize: 9, fill: "#aaa" };
  const grid  = { stroke: "#f4f4f4", strokeDasharray: "3 3" };

  return (
    <div style={{ marginTop: 24, opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(12px)", transition: "opacity 0.4s ease, transform 0.4s ease" }}>
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
              <linearGradient id="gInv"  x1="0" y1="0" x2="0" y2="1"><stop offset="5%"  stopColor="#3b5bdb" stopOpacity={0.6} /><stop offset="95%" stopColor="#3b5bdb" stopOpacity={0.04} /></linearGradient>
              <linearGradient id="gCash" x1="0" y1="0" x2="0" y2="1"><stop offset="5%"  stopColor="#74c0fc" stopOpacity={0.4} /><stop offset="95%" stopColor="#74c0fc" stopOpacity={0.02} /></linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis {...xAxis} />
            <YAxis tick={yTick} tickFormatter={v => `₹${v.toFixed(0)}L`} axisLine={false} tickLine={false} width={54} />
            <Tooltip content={<ChartTooltip suffix="L" decimals={2} />} />
            <Legend wrapperStyle={{ fontFamily: SYS, fontSize: 10, color: "#777" }} />
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
            <XAxis {...xAxis} />
            <YAxis tick={yTick} tickFormatter={v => `${v.toFixed(1)}%`} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<ChartTooltip suffix="%" decimals={2} />} />
            <ReferenceLine y={0} stroke="#ddd" />
            <Area type="monotone" dataKey="drawdown" name="Drawdown" stroke="#e03131" fill="url(#gDd)" strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard num="C3" title="Rolling 1-Year Sharpe Ratio" height={150}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 4, right: 14, left: 0, bottom: 0 }}>
            <CartesianGrid {...grid} />
            <XAxis {...xAxis} />
            <YAxis tick={yTick} tickFormatter={v => v.toFixed(1)} axisLine={false} tickLine={false} width={34} />
            <Tooltip content={<ChartTooltip decimals={2} />} />
            <ReferenceLine y={0} stroke="#ddd" strokeDasharray="4 3" />
            <ReferenceLine y={1} stroke="#1b6f3e" strokeDasharray="4 3" strokeOpacity={0.5} />
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

  const [form,   setForm]   = useState(DEFAULT_FORM);
  const [errors, setErrors] = useState({});

  const [btLoading,  setBtLoading]  = useState(false);
  const [depLoading, setDepLoading] = useState(false);

  const [showBtModal,  setShowBtModal]  = useState(false);
  const [showDepModal, setShowDepModal] = useState(false);

  const [btAlert,  setBtAlert]  = useState(null);
  const [depAlert, setDepAlert] = useState(null);

  // Populated after successful deploy: { id, status, nextRebalance }
  const [deployedStrategy, setDeployedStrategy] = useState(null);

  const [btResult,      setBtResult]      = useState(null);
  const [btConfig,      setBtConfig]      = useState(null);
  const [resultVisible, setResultVisible] = useState(false);

  const [mounted, setMounted] = useState(false);
  const resultRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 40);
    return () => clearTimeout(t);
  }, []);

  const setField = useCallback((key) => (e) => {
    const val = e.target.type === "number"
      ? (e.target.value === "" ? "" : Number(e.target.value))
      : e.target.value;
    setForm(prev => ({ ...prev, [key]: val }));
    setErrors(prev => ({ ...prev, [key]: undefined }));
  }, []);

  function setRebalanceType(type) {
    setForm(prev => ({ ...prev, rebalanceType: type, rebalanceFreq: 1, startingDate: TOMORROW }));
  }

  // ── BACKTEST ──────────────────────────────────────────────────────────────
  function handleBacktestClick() {
    const errs = validateForm(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setBtAlert(null);
    setShowBtModal(true);
  }

  async function runBacktest(backtestStartDate) {
    setShowBtModal(false);

    // Full payload sent to /strategy/backtest
    const config = {
      universe:         form.universe,
      numStocks:        Number(form.numStocks),
      lookback1:        Number(form.lookback1),
      lookback2:        Number(form.lookback2),
      priceCap:         form.priceCap !== "" ? Number(form.priceCap) : null,
      capital:          Number(form.capital),
      rebalanceType:    form.rebalanceType,
      rebalanceFreq:    Number(form.rebalanceFreq),
      backtestStartDate,
    };

    setBtLoading(true);
    setBtResult(null);
    setResultVisible(false);
    setBtAlert(null);

    try {
      const result = await postJSON(`${BASE_URL}/strategy/backtest`, config);
      setBtConfig({ ...config, numStocks: form.numStocks });
      setBtResult(result);
      setTimeout(() => setResultVisible(true), 80);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 220);
    } catch (err) {
      setBtAlert({
        type: "error",
        title: "Backtest Failed",
        message: err.message || "An unexpected error occurred. Please try again.",
      });
    } finally {
      setBtLoading(false);
    }
  }

  // ── DEPLOY ────────────────────────────────────────────────────────────────
  function handleDeployClick() {
    // Deploy uses stricter validation (startingDate ≥ tomorrow)
    const errs = validateDeploy(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setDepAlert(null);
    setShowDepModal(true);
  }

  async function runDeploy() {
    setDepLoading(true);
    setDepAlert(null);

    // Exact payload shape documented for POST /strategy/deploy
    const payload = {
      universe:      form.universe,
      numStocks:     Number(form.numStocks),
      lookback1:     Number(form.lookback1),
      lookback2:     Number(form.lookback2),
      priceCap:      form.priceCap !== "" ? Number(form.priceCap) : null,
      capital:       Number(form.capital),
      rebalanceType: form.rebalanceType,
      rebalanceFreq: Number(form.rebalanceFreq),
      startingDate:  form.startingDate,
    };

    try {
      // Success shape: { success: true, strategyId, status, nextRebalance }
      const data = await postJSON(`${BASE_URL}/strategy/deploy`, payload);

      if (!data.success) {
        throw new Error(data.message || "Deployment was unsuccessful.");
      }

      // Store flat fields — backend has NO nested strategy object
      setDeployedStrategy({
        id:            data.strategyId,
        status:        data.status,
        nextRebalance: data.nextRebalance,
      });

      setShowDepModal(false);

      const nextDate = data.nextRebalance
        ? new Date(data.nextRebalance).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
        : "—";

      setDepAlert({
        type: "success",
        title: `Strategy Live · ID: ${data.strategyId}`,
        message: `Status: ${(data.status ?? "active").toUpperCase()} · Capital: ${fmtRupee(form.capital)} · Next rebalance: ${nextDate}. Redirecting to dashboard…`,
      });

      setTimeout(() => navigate("/dashboard"), 2500);

    } catch (err) {
      setShowDepModal(false);

      // Translate every known backend error to a clear user message
      let msg = err.message || "Could not deploy strategy. Please try again.";
      const lower = msg.toLowerCase();

      if (lower.includes("connect broker") || lower.includes("no broker"))
        msg = "Broker not connected. Please connect your broker account before deploying.";
      else if (lower.includes("available") && lower.includes("balance"))
        msg = msg; // already contains specific amounts — keep as-is e.g. "Available=499999.00, Requested=500000.00"
      else if (lower.includes("unable to verify") || lower.includes("broker funds"))
        msg = "Unable to verify broker funds right now. Please try again in a moment.";
      else if (msg === "Invalid input data")
        msg = "Some inputs are invalid. Please review your configuration and try again.";
      else if (msg === "Server error")
        msg = "The server encountered an error. Please try again in a moment.";

      setDepAlert({
        type: "error",
        title: "Deployment Failed",
        message: msg,
      });
    } finally {
      setDepLoading(false);
    }
  }

  const anyLoading = btLoading || depLoading;
  const isWeekly   = form.rebalanceType === "weekly";
  const freqLabel  = n => isWeekly ? `Every ${n} week${n > 1 ? "s" : ""}` : `Every ${n} month${n > 1 ? "s" : ""}`;

  const summaryRows = [
    ["Universe",  UNIVERSES.find(u => u.value === form.universe)?.label || "—"],
    ["Stocks",    form.numStocks ? String(form.numStocks) : "—"],
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
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .dp-root  { min-height: calc(100vh - 60px); background: #f3f3f3; padding: 28px 20px 72px; font-family: ${SYS}; }
        .dp-wrap  { max-width: 1180px; margin: 0 auto; opacity: 0; transform: translateY(10px); transition: opacity 0.35s ease, transform 0.35s ease; }
        .dp-wrap.mounted { opacity: 1; transform: translateY(0); }

        .dp-layout { display: grid; grid-template-columns: 1fr 296px; gap: 14px; align-items: start; }
        @media (max-width: 840px) { .dp-layout { grid-template-columns: 1fr; } .dp-root { padding: 16px 14px 60px; } }

        .dp-side { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 80px; }

        .g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .g4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
        @media (max-width: 540px) { .g2 { grid-template-columns: 1fr; } .g4 { grid-template-columns: repeat(2, 1fr); } }

        .uni-opt       { padding: 11px 8px; border-radius: 7px; cursor: pointer; border: 1.5px solid #e0e0e0; background: #fff; text-align: center; transition: border-color 0.13s, background 0.13s; user-select: none; }
        .uni-opt:hover { border-color: #aaa; }
        .uni-opt.sel   { border-color: #1a1a1a; background: #f0f0f0; }
        .uni-name { font-size: 13px; font-weight: 700; color: #111; margin-bottom: 2px; }
        .uni-desc { font-size: 10px; color: #888; }

        .rtoggle           { display: flex; border: 1.5px solid #e0e0e0; border-radius: 7px; overflow: hidden; background: #f5f5f5; margin-bottom: 14px; }
        .rtbtn             { flex: 1; padding: 9px 12px; font-size: 12px; font-weight: 600; border: none; cursor: pointer; background: transparent; color: #666; text-transform: uppercase; letter-spacing: 0.04em; transition: all 0.14s; display: flex; align-items: center; justify-content: center; gap: 5px; }
        .rtbtn:first-child { border-right: 1.5px solid #e0e0e0; }
        .rtbtn.on          { background: #1a1a1a; color: #fff; }

        .dp-summary       { background: #fff; border: 1px solid #e8e8e8; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
        .dp-summary-title { font-size: 11px; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 12px; }
        .dp-sgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }
        .dp-sk    { font-size: 10px; color: #999; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
        .dp-sv    { font-size: 13px; font-weight: 700; color: #111; font-family: ${MONO}; }

        .dp-btn-row      { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 4px; }
        .dp-btn          { padding: 13px 16px; border-radius: 8px; font-size: 13px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; cursor: pointer; border: none; display: flex; align-items: center; justify-content: center; gap: 7px; transition: all 0.15s; font-family: ${SYS}; }
        .dp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .dp-btn.outline  { background: #fff; color: #333; border: 1.5px solid #d0d0d0; }
        .dp-btn.outline:hover:not(:disabled) { background: #f5f5f5; border-color: #999; }
        .dp-btn.solid    { background: #1a1a1a; color: #fff; }
        .dp-btn.solid:hover:not(:disabled)   { background: #333; }

        .dots      { display: flex; gap: 3px; align-items: center; }
        .dots span { width: 4px; height: 4px; border-radius: 50%; background: currentColor; animation: dot 0.9s ease-in-out infinite; }
        .dots span:nth-child(2) { animation-delay: 0.15s; }
        .dots span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes dot { 0%,80%,100%{transform:scale(1);opacity:0.5} 40%{transform:scale(1.4);opacity:1} }

        @keyframes fadeUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        .fade-up { animation: fadeUp 0.22s ease; }
      `}</style>

      {showBtModal && (
        <BacktestDateModal onConfirm={runBacktest} onCancel={() => setShowBtModal(false)} />
      )}
      {showDepModal && (
        <DeployConfirmModal
          form={form}
          onConfirm={runDeploy}
          onCancel={() => { if (!depLoading) setShowDepModal(false); }}
          loading={depLoading}
        />
      )}

      <div className="dp-root">
        <div className={`dp-wrap ${mounted ? "mounted" : ""}`}>

          {/* Page header */}
          <div style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>Strategy Configuration</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#111", marginBottom: 4, letterSpacing: "-0.02em" }}>Deploy Strategy</div>
            <div style={{ fontSize: 13, color: "#666", lineHeight: 1.6 }}>Configure your momentum strategy parameters before backtesting or going live.</div>
          </div>

          <div className="dp-layout">

            {/* ── LEFT: Form ── */}
            <div>

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

              <Section number="2" title="Portfolio Parameters">
                <div className="g2">
                  <div>
                    <Label hint="— stocks held at any time">No. of Stocks</Label>
                    <NumberInput
                      value={form.numStocks}
                      onChange={setField("numStocks")}
                      placeholder="e.g. 10"
                      suffix="stocks"
                      error={errors.numStocks}
                      min={1}
                      disabled={anyLoading}
                    />
                    <FieldError msg={errors.numStocks} />
                  </div>
                  <div>
                    <Label hint="— optional max price filter">Stock Price Cap</Label>
                    <NumberInput
                      value={form.priceCap}
                      onChange={setField("priceCap")}
                      placeholder="No limit"
                      prefix="₹"
                      error={errors.priceCap}
                      min={1}
                      disabled={anyLoading}
                    />
                    <FieldError msg={errors.priceCap} />
                  </div>
                </div>
              </Section>

              <Section number="3" title="Lookback Periods">
                <div className="g2">
                  <div>
                    <Label hint="— primary return window">Period 1</Label>
                    <Dropdown
                      value={form.lookback1}
                      onChange={setField("lookback1")}
                      options={MONTHS.map(n => ({ value: n, label: `${n} month${n > 1 ? "s" : ""}` }))}
                      error={errors.lookback1}
                      disabled={anyLoading}
                    />
                    <FieldError msg={errors.lookback1} />
                  </div>
                  <div>
                    <Label hint="— secondary return window">Period 2</Label>
                    <Dropdown
                      value={form.lookback2}
                      onChange={setField("lookback2")}
                      options={MONTHS.map(n => ({ value: n, label: `${n} month${n > 1 ? "s" : ""}` }))}
                      error={errors.lookback2}
                      disabled={anyLoading}
                    />
                    <FieldError msg={errors.lookback2} />
                  </div>
                </div>
                <Hint>Two different windows (e.g. <strong>6M + 12M</strong>) reduce signal noise and improve rank stability.</Hint>
              </Section>

              <Section number="4" title="Capital & Rebalancing">
                <div style={{ marginBottom: 16 }}>
                  <Label hint="— total amount to deploy">Capital</Label>
                  <NumberInput
                    value={form.capital}
                    onChange={setField("capital")}
                    placeholder="e.g. 500000"
                    prefix="₹"
                    error={errors.capital}
                    min={10000}
                    disabled={anyLoading}
                  />
                  <FieldError msg={errors.capital} />
                </div>

                <Label hint="— schedule cadence">Rebalance Type</Label>
                <div className="rtoggle">
                  <button className={`rtbtn ${!isWeekly ? "on" : ""}`} onClick={() => setRebalanceType("monthly")} disabled={anyLoading}>
                    📅 Monthly
                  </button>
                  <button className={`rtbtn ${isWeekly ? "on" : ""}`} onClick={() => setRebalanceType("weekly")} disabled={anyLoading}>
                    ⚡ Weekly
                  </button>
                </div>

                <div key={isWeekly ? "w" : "m"} className="fade-up">
                  <div className="g2">
                    <div>
                      <Label hint={isWeekly ? "— 1 to 52 weeks" : "— 1 to 12 months"}>Frequency</Label>
                      <Dropdown
                        value={form.rebalanceFreq}
                        onChange={setField("rebalanceFreq")}
                        options={(isWeekly ? WEEKS : MONTHS).map(n => ({ value: n, label: freqLabel(n) }))}
                        disabled={anyLoading}
                      />
                    </div>
                    <div>
                      <Label hint="— first rebalance date">Starting Date</Label>
                      <div style={{ border: `1.5px solid ${errors.startingDate ? "#c62828" : "#d0d0d0"}`, borderRadius: 7, background: "#fff" }}>
                        <input
                          type="date"
                          value={form.startingDate}
                          onChange={setField("startingDate")}
                          min={TOMORROW}
                          disabled={anyLoading}
                          style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: 13, color: "#111", padding: "9px 11px", cursor: anyLoading ? "not-allowed" : "pointer", fontFamily: SYS }}
                        />
                      </div>
                      <FieldError msg={errors.startingDate} />
                    </div>
                  </div>
                  <Hint>
                    Starts <strong>{form.startingDate || "—"}</strong>, rebalances <strong>{freqLabel(form.rebalanceFreq)}</strong>.{" "}
                    {isWeekly ? "Higher frequency increases turnover costs." : "Lower frequency reduces transaction costs."}
                  </Hint>
                </div>
              </Section>

              <div className="dp-btn-row">
                <button className="dp-btn outline" onClick={handleBacktestClick} disabled={anyLoading}>
                  {btLoading ? <><span>Running</span><LoadingDots /></> : <><span>⟳</span> Backtest</>}
                </button>
                <button className="dp-btn solid" onClick={handleDeployClick} disabled={anyLoading}>
                  {depLoading ? <><span>Deploying</span><LoadingDots /></> : <><span>▶</span> Deploy Live</>}
                </button>
              </div>

              {btAlert && (
                <AlertBanner
                  type={btAlert.type}
                  title={btAlert.title}
                  message={btAlert.message}
                  onDismiss={() => setBtAlert(null)}
                />
              )}
              {depAlert && (
                <AlertBanner
                  type={depAlert.type}
                  title={depAlert.title}
                  message={depAlert.message}
                  onDismiss={() => setDepAlert(null)}
                />
              )}
            </div>

            {/* ── RIGHT: Sticky Sidebar ── */}
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

              <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, padding: "14px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>Quick Tips</div>
                {[
                  ["Universe", "Larger universes offer more diversification but more diluted signals."],
                  ["Lookback",  "Combining 6M + 12M windows is a classic momentum setup."],
                  ["Capital",   "Broker available balance must exactly match the capital you enter."],
                ].map(([t, tip], i, arr) => (
                  <div key={t} style={{ marginBottom: i < arr.length - 1 ? 10 : 0, paddingBottom: i < arr.length - 1 ? 10 : 0, borderBottom: i < arr.length - 1 ? "1px solid #f4f4f4" : "none" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#222", marginBottom: 2 }}>{t}</div>
                    <div style={{ fontSize: 12, color: "#555", lineHeight: 1.55 }}>{tip}</div>
                  </div>
                ))}
              </div>

              {/* Live strategy card — appears after successful deploy */}
              {deployedStrategy && (
                <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#166534", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>Live Strategy</div>
                  {[
                    ["ID",             deployedStrategy.id],
                    ["Status",         (deployedStrategy.status ?? "active").toUpperCase()],
                    ["Next Rebalance", deployedStrategy.nextRebalance
                      ? new Date(deployedStrategy.nextRebalance).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
                      : "—"],
                  ].map(([k, v]) => (
                    <div key={k} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, color: "#16a34a", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{k}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#14532d", fontFamily: MONO, wordBreak: "break-all" }}>{v}</div>
                    </div>
                  ))}
                </div>
              )}

            </div>
          </div>

          {/* Backtest results */}
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