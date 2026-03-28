import { SYS, MONO } from "../constants.js";

// ─── STAT CARD ────────────────────────────────────────────────────────────────
export function StatCard({ label, value, sub, pnlType, delay, flash }) {
  const isPos = pnlType === "pos";
  const isNeg = pnlType === "neg";
  return (
    <div style={{
      background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8,
      padding: "18px 20px",
      opacity: 0, transform: "translateY(8px)",
      animation: `statIn 0.35s ease ${delay} forwards`,
      transition: "background 0.4s ease",
      ...(flash ? { background: "#f0fdf4" } : {}),
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10, fontFamily: SYS }}>{label}</div>
      <div style={{
        fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 6, fontFamily: MONO,
        color: isPos ? "#1b6f3e" : isNeg ? "#c62828" : "#111",
        transition: "color 0.3s",
      }}>{value}</div>
      {sub && (
        pnlType
          ? <span style={{ display: "inline-block", fontSize: 11, fontWeight: 600, fontFamily: MONO, padding: "2px 8px", borderRadius: 4, background: isPos ? "#ebf7ef" : "#fdecea", color: isPos ? "#1b6f3e" : "#c62828" }}>{sub}</span>
          : <span style={{ fontSize: 11, color: "#999", fontFamily: MONO }}>{sub}</span>
      )}
    </div>
  );
}

// ─── PRICE SOURCE BADGE ───────────────────────────────────────────────────────
export function PriceSourceBadge({ source }) {
  if (!source) return null;
  const isLive = source === "live";
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
      padding: "2px 6px", borderRadius: 4,
      background: isLive ? "#dcfce7" : "#f3f4f6",
      color: isLive ? "#15803d" : "#6b7280",
      fontFamily: SYS, marginLeft: 6,
    }}>
      {isLive ? "● Live" : "Delayed"}
    </span>
  );
}
