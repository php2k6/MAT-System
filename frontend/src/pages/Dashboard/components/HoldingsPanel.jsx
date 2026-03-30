import { MONO, SYS } from "../constants.js";
import { fmt, fmtCompact } from "../formatters.js";
import { PriceSourceBadge } from "./StatCard.jsx";

// ─── EMPTY STATE ROW ──────────────────────────────────────────────────────────
function EmptyRow({ message }) {
  return (
    <tr>
      <td colSpan={6} style={{
        padding: "36px 20px", textAlign: "center",
        fontFamily: SYS, color: "#aaa", fontSize: 13,
      }}>
        {message}
      </td>
    </tr>
  );
}

// ─── SHARED TABLE ─────────────────────────────────────────────────────────────
// Day Chg column removed — all calculations are frontend-only from ltp+qty+avgPrice.
function PositionsTable({ items, emptyMessage }) {
  return (
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
          </tr>
        </thead>
        <tbody>
          {(items ?? []).length === 0
            ? <EmptyRow message={emptyMessage} />
            : (items ?? []).map(h => {
              const pos = h.pnl >= 0;
              return (
                <tr key={h.symbol}>
                  <td>
                    <div className="db-sym">{h.symbol}</div>
                    {h.name && <div className="db-sym-name">{h.name}</div>}
                  </td>
                  <td>{h.qty}</td>
                  <td>{fmt(h.avgPrice)}</td>
                  <td
                    style={{ color: "#111", fontWeight: 600 }}
                    key={`ltp-${h.symbol}-${h.priceTs}`}
                    className={h.priceSource === "live" ? "ltp-flash" : ""}
                  >
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
                </tr>
              );
            })
          }
        </tbody>
      </table>
    </div>
  );
}

// ─── HOLDINGS PANEL ───────────────────────────────────────────────────────────
export function HoldingsPanel({ holdings }) {
  return (
    <div className="db-panel">
      <div className="db-panel-header">
        <span className="db-panel-title">Current Holdings</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {holdings?.[0]?.priceSource && (
            <PriceSourceBadge source={holdings[0].priceSource} />
          )}
          <span style={{ fontSize: 11, color: "#999", fontFamily: MONO }}>
            {holdings?.length ?? 0} stocks
          </span>
        </div>
      </div>
      <PositionsTable
        items={holdings}
        emptyMessage="No holdings yet — positions will appear after the first rebalance."
      />
    </div>
  );
}

// ─── POSITIONS PANEL ──────────────────────────────────────────────────────────
// Shows intraday positions (today's buys/sells) from the broker.
// Total P&L is summed from frontend-calculated pnl of each row.
export function PositionsPanel({ positions }) {
  const totalPnl = (positions ?? []).reduce((sum, p) => sum + (Number(p.pnl) || 0), 0);
  const isPos    = totalPnl >= 0;
  const hasItems = (positions ?? []).length > 0;

  return (
    <div className="db-panel">
      <div className="db-panel-header">
        <span className="db-panel-title">Today's Positions</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {positions?.[0]?.priceSource && (
            <PriceSourceBadge source={positions[0].priceSource} />
          )}
          <span style={{ fontSize: 11, color: "#999", fontFamily: MONO }}>
            {positions?.length ?? 0} stocks
          </span>
        </div>
      </div>

      {/* P&L summary bar — only shown when there are rows */}
      {hasItems && (
        <div style={{
          display: "flex", alignItems: "center", gap: 16,
          padding: "10px 18px",
          borderBottom: "1px solid #f0f0f0",
          background: isPos ? "#f0fdf4" : "#fef2f2",
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#999", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: SYS }}>
            Total P&L
          </span>
          <span style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, color: isPos ? "#1b6f3e" : "#c62828" }}>
            {isPos ? "+" : ""}{fmtCompact(totalPnl)}
          </span>
          <span style={{ fontSize: 11, fontFamily: MONO, color: isPos ? "#1b6f3e" : "#c62828" }}>
            {fmt(totalPnl)}
          </span>
        </div>
      )}

      <PositionsTable
        items={positions}
        emptyMessage="No open positions today."
      />
    </div>
  );
}