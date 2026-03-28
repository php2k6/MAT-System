import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid
} from "recharts";
import { SYS, MONO, CHART_RANGES } from "../constants.js";
import { fmt } from "../formatters.js";
import { Spinner } from "./Feedback.jsx";

// ─── CHART TOOLTIP ────────────────────────────────────────────────────────────
export function ChartTooltip({ active, payload, label }) {
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

// ─── PORTFOLIO CHART PANEL ────────────────────────────────────────────────────
export function PortfolioChartPanel({ chartData, chartLoading, range, onRangeChange }) {
  return (
    <div className="db-panel" style={{ marginBottom: 20 }}>
      <div className="db-panel-header">
        <span className="db-panel-title">Portfolio Value</span>
        <div className="db-ranges">
          {CHART_RANGES.map(r => (
            <button
              key={r}
              className={`db-range ${range === r ? "db-range-on" : "db-range-off"}`}
              onClick={() => onRangeChange(r)}
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
  );
}
