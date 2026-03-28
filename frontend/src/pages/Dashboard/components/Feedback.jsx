import { SYS } from "../constants.js";

// ─── SPINNER ──────────────────────────────────────────────────────────────────
export function Spinner({ size = 32 }) {
  return (
    <div style={{
      width: size, height: size,
      border: "2.5px solid #e8e8e8", borderTopColor: "#333",
      borderRadius: "50%", animation: "dbSpin 0.7s linear infinite",
    }} />
  );
}

// ─── ERROR BANNER ─────────────────────────────────────────────────────────────
export function ErrorBanner({ message, onDismiss }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 7,
      padding: "10px 14px", marginBottom: 18, gap: 12,
    }}>
      <span style={{ fontSize: 12, color: "#b91c1c", fontFamily: SYS }}>⚠ {message}</span>
      {onDismiss && (
        <button onClick={onDismiss} style={{ background: "none", border: "none", color: "#b91c1c", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0, fontFamily: SYS }}>×</button>
      )}
    </div>
  );
}
