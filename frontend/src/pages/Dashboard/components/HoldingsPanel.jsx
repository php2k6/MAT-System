import { MONO } from "../constants.js";
import { fmt, fmtCompact } from "../formatters.js";
import { PriceSourceBadge } from "./StatCard.jsx";

// ─── EMPTY STATE ROW ──────────────────────────────────────────────────────────
function EmptyRow({ message }) {
  return (
    <tr>
      <td colSpan={7} style={{
        padding: "36px 20px", textAlign: "center",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        color: "#aaa", fontSize: 13,
      }}>
        {message}
      </td>
    </tr>
  );
}

// ─── SHARED POSITIONS TABLE ───────────────────────────────────────────────────
// Used by both HoldingsPanel and PositionsPanel — identical columns.
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
            <th>Day Chg</th>
          </tr>
        </thead>
        <tbody>
          {(items ?? []).length === 0
            ? <EmptyRow message={emptyMessage} />
            : (items ?? []).map(h => {
              const pos = h.pnl >= 0;

              const dc = Number(h.dayChange);
              const dayChange = Number.isFinite(dc) ? dc : 0;
              const dayPos = dayChange >= 0;

              return (
                <tr key={h.symbol}>
                  <td>
                    <div className="db-sym">{h.symbol}</div>
                    {h.name && <div className="db-sym-name">{h.name}</div>}
                  </td>
                  <td>{h.qty}</td>
                  <td>{fmt(h.avgPrice)}</td>
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
                    {dayPos ? "+" : ""}{dayChange.toFixed(2)}%
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
export function PositionsPanel({ positions }) {
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
      <PositionsTable
        items={positions}
        emptyMessage="No open positions today."
      />
    </div>
  );
}