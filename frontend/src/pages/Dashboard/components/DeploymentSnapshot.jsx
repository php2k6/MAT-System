import { SYS, MONO } from "../constants.js";
import { fmt, fmtCompact } from "../formatters.js";

// ─── DAY-ZERO BANNER ──────────────────────────────────────────────────────────
// Shown when strategy is deployed but no trades have been placed yet.
export function DayZeroBanner({ nextRebalance }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 12,
      background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8,
      padding: "14px 18px", marginBottom: 24, fontFamily: SYS,
    }}>
      <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>🕐</span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1e40af", marginBottom: 4 }}>
          Awaiting First Trade
        </div>
        <div style={{ fontSize: 12, color: "#3b5bdb", lineHeight: 1.65 }}>
          Your strategy is live and configured. Holdings and portfolio value will appear here after
          the first rebalance
          {nextRebalance ? <> on <strong>{nextRebalance}</strong></> : null}.
          {" "}No action is needed from your side.
        </div>
        {nextRebalance && (
          <div style={{ marginTop: 8, fontSize: 11, color: "#1d4ed8", fontWeight: 600 }}>
            First rebalance scheduled: {nextRebalance}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DEPLOYMENT SNAPSHOT PANEL ───────────────────────────────────────────────
export function DeploymentSnapshot({ initialCapital, currentValue }) {
  const pnl = Number(currentValue ?? 0) - Number(initialCapital ?? 0);
  const pnlPct = Number(initialCapital) > 0 ? (pnl / Number(initialCapital)) * 100 : 0;
  const isPos = pnl >= 0;

  const itemStyle = {
    background: "#fff",
    border: "1px solid #e7e7e7",
    borderRadius: 8,
    padding: "14px 16px",
  };

  return (
    <div className="db-panel" style={{ marginBottom: 20 }}>
      <div className="db-panel-header">
        <span className="db-panel-title">Deployment vs Current</span>
      </div>

      <div style={{ padding: 12 }}>
        <div className="db-deploy-grid">
          <div style={itemStyle}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#999", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8, fontFamily: SYS }}>
              Initial Capital
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#111", fontFamily: MONO }}>
              {fmtCompact(initialCapital)}
            </div>
            <div style={{ fontSize: 11, color: "#999", fontFamily: MONO, marginTop: 4 }}>
              {fmt(initialCapital)}
            </div>
          </div>

          <div style={itemStyle}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#999", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8, fontFamily: SYS }}>
              Current Value
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#111", fontFamily: MONO }}>
              {fmtCompact(currentValue)}
            </div>
            <div style={{ fontSize: 11, color: "#999", fontFamily: MONO, marginTop: 4 }}>
              {fmt(currentValue)}
            </div>
          </div>

          <div style={itemStyle}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#999", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8, fontFamily: SYS }}>
              P&L
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: isPos ? "#1b6f3e" : "#c62828", fontFamily: MONO }}>
              {isPos ? "+" : ""}{fmtCompact(pnl)}
            </div>
            <div style={{ fontSize: 11, fontFamily: MONO, marginTop: 4, color: isPos ? "#1b6f3e" : "#c62828" }}>
              {isPos ? "▲" : "▼"} {Math.abs(pnlPct).toFixed(2)}%
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
