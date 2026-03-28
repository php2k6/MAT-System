import { MONO } from "../constants.js";
import { fmt, fmtCompact } from "../formatters.js";
import { PriceSourceBadge } from "./StatCard.jsx";

// ─── HOLDINGS EMPTY STATE ─────────────────────────────────────────────────────
function HoldingsEmptyRow() {
  return (
    <tr>
      <td colSpan={7} style={{
        padding: "36px 20px", textAlign: "center",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        color: "#aaa", fontSize: 13,
      }}>
        No holdings yet — positions will appear after the first rebalance.
      </td>
    </tr>
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
            {holdings?.length ?? 0} positions
          </span>
        </div>
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
            {(holdings ?? []).length === 0
              ? <HoldingsEmptyRow />
              : (holdings ?? []).map(h => {
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
    </div>
  );
}
