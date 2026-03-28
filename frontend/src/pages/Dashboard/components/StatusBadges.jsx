import { SYS, STATUS_CONFIG } from "../constants.js";

// ─── WS STATUS PILL ───────────────────────────────────────────────────────────
export function WsStatusPill({ status }) {
  const map = {
    live:         { label: "Live",         color: "#15803d", dot: "#22c55e", bg: "#dcfce7", border: "#bbf7d0", pulse: true },
    connecting:   { label: "Connecting…",  color: "#a16207", dot: "#eab308", bg: "#fef9c3", border: "#fef08a", pulse: false },
    disconnected: { label: "Disconnected", color: "#b91c1c", dot: "#ef4444", bg: "#fee2e2", border: "#fecaca", pulse: false },
    no_strategy:  { label: "No Strategy",  color: "#6b7280", dot: "#9ca3af", bg: "#f3f4f6", border: "#e5e7eb", pulse: false },
  };
  const cfg = map[status] || map.disconnected;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 9px", borderRadius: 20,
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      fontSize: 10, fontWeight: 700, color: cfg.color,
      fontFamily: SYS, letterSpacing: "0.03em",
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: "50%",
        background: cfg.dot, display: "inline-block",
        animation: cfg.pulse ? "pulse 2s ease-in-out infinite" : "none",
      }} />
      {cfg.label}
    </span>
  );
}

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────
export function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.stopped;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 10px", borderRadius: 20,
      background: cfg.bg, border: `1px solid ${cfg.ring}`,
      fontSize: 11, fontWeight: 700, color: cfg.color, fontFamily: SYS,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%", background: cfg.dot, display: "inline-block",
        animation: status === "active" ? "pulse 2s ease-in-out infinite" : "none",
      }} />
      {cfg.label}
    </span>
  );
}
