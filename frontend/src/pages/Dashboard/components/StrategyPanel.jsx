import { useState } from "react";
import { SYS, MONO } from "../constants.js";
import { fmt, fmtCompact } from "../formatters.js";
import { StatusBadge } from "./StatusBadges.jsx";

// ─── ACTION BUTTON ────────────────────────────────────────────────────────────
export function ActionBtn({ label, icon, onClick, bg, color, border }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "7px 13px", borderRadius: 6,
        border: border || "none",
        background: bg, color,
        fontSize: 11, fontWeight: 700, cursor: "pointer",
        letterSpacing: "0.03em", textTransform: "uppercase",
        fontFamily: SYS, transition: "opacity 0.13s, transform 0.1s",
        opacity: hovered ? 0.82 : 1,
        transform: hovered ? "translateY(-1px)" : "none",
      }}
    >
      <span style={{ fontSize: 10 }}>{icon}</span> {label}
    </button>
  );
}

// ─── STRATEGY PANEL ───────────────────────────────────────────────────────────
export function StrategyPanel({ strategy, onAction }) {
  const metrics = [
    ["Universe",       strategy.universe],
    ["No. of Stocks",  `${strategy.numStocks} stocks`],
    ["Price Cap",      strategy.priceCap ? fmt(strategy.priceCap) : "No limit"],
    ["Lookback 1",     `${strategy.lookback1} months`],
    ["Lookback 2",     `${strategy.lookback2} months`],
    ["Capital",        fmtCompact(strategy.capital)],
    ["Rebalance",      strategy.rebalanceType === "monthly" ? "Monthly" : "Weekly"],
    ["Frequency",      `Every ${strategy.frequency} ${strategy.rebalanceType === "monthly" ? "month" : "week"}${strategy.frequency > 1 ? "s" : ""}`],
    ["Started",        strategy.startingDate],
    ["Last Rebalance", strategy.lastRebalanced],
    ["Next Rebalance", strategy.nextRebalance],
  ];

  const isActive  = strategy.status === "active";
  const isPaused  = strategy.status === "paused";
  const isStopped = strategy.status === "stopped";

  return (
    <div style={{
      background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8,
      overflow: "hidden", marginBottom: 24,
      animation: "panelIn 0.3s ease both",
    }}>
      <div style={{
        padding: "13px 20px", borderBottom: "1px solid #ebebeb", background: "#f8f8f8",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#333", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: SYS }}>
            Deployed Strategy
          </span>
          <StatusBadge status={strategy.status} />
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          {(isPaused || isStopped) && (
            <ActionBtn label={isStopped ? "Restart" : "Resume"} icon="▶" onClick={() => onAction(isStopped ? "restart" : "resume")} bg="#111" color="#fff" />
          )}
          {isActive && (
            <ActionBtn label="Pause" icon="⏸" onClick={() => onAction("pause")} bg="#fff" color="#555" border="1px solid #ccc" />
          )}
          {!isStopped && (
            <ActionBtn label="Stop" icon="■" onClick={() => onAction("stop")} bg="#fff" color="#c62828" border="1px solid #fca5a5" />
          )}
        </div>
      </div>

      <div style={{ padding: "4px 8px 8px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))" }}>
          {metrics.map(([key, val]) => (
            <div key={key} style={{ padding: "10px 12px", borderBottom: "1px solid #f5f5f5" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "#aaa", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4, fontFamily: SYS }}>{key}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#111", fontFamily: MONO }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
