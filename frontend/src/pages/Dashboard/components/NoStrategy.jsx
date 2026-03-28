import { SYS } from "../constants.js";

// ─── NO STRATEGY ─────────────────────────────────────────────────────────────
export function NoStrategy({ onDeploy }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      minHeight: "46vh", textAlign: "center", padding: "40px 20px",
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: "50%",
        border: "1.5px solid #e0e0e0", background: "#f5f5f5",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 24, color: "#999", marginBottom: 20,
      }}>◈</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontFamily: SYS }}>
        No Strategy Active
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#111", marginBottom: 8, fontFamily: SYS }}>
        No Strategy Deployed
      </div>
      <div style={{ width: 36, height: 1, background: "#e0e0e0", margin: "0 auto 16px" }} />
      <div style={{ fontSize: 13, color: "#666", lineHeight: 1.7, maxWidth: 360, marginBottom: 28, fontFamily: SYS }}>
        Deploy a momentum strategy to activate live tracking, portfolio analytics, and holdings data.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", maxWidth: 360, marginBottom: 28, textAlign: "left" }}>
        {[
          ["1", "Choose a momentum strategy from the library"],
          ["2", "Configure risk parameters and capital allocation"],
          ["3", "Deploy — dashboard activates automatically"],
        ].map(([num, text]) => (
          <div key={num} style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            padding: "10px 14px", background: "#fff", border: "1px solid #e8e8e8", borderRadius: 7,
          }}>
            <span style={{
              width: 20, height: 20, borderRadius: 5, background: "#222", color: "#fff",
              fontSize: 10, fontWeight: 700, fontFamily: SYS,
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0, marginTop: 1,
            }}>{num}</span>
            <span style={{ fontSize: 12, color: "#555", lineHeight: 1.55, fontFamily: SYS }}>{text}</span>
          </div>
        ))}
      </div>
      <button
        onClick={onDeploy}
        style={{
          padding: "11px 28px", borderRadius: 7, border: "none",
          background: "#222", color: "#fff",
          fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
          cursor: "pointer", fontFamily: SYS,
        }}
        onMouseEnter={e => e.currentTarget.style.background = "#3a3a3a"}
        onMouseLeave={e => e.currentTarget.style.background = "#222"}
      >
        Deploy Strategy
      </button>
    </div>
  );
}
