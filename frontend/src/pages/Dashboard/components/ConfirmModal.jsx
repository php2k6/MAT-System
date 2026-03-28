import { SYS } from "../constants.js";

// ─── CONFIRM MODAL ────────────────────────────────────────────────────────────
export function ConfirmModal({ action, onConfirm, onCancel }) {
  const map = {
    stop: {
      title: "Stop Strategy",
      desc: (
        <div>
          <p style={{ marginBottom: 10, fontSize: 13, color: "#555", lineHeight: 1.6 }}>
            This will <strong>immediately halt</strong> the strategy. <strong>All holdings remain in your account</strong> — you must manually sell them in your broker.
          </p>
          <div style={{
            display: "flex", gap: 8, alignItems: "flex-start",
            background: "#fef9c3", border: "1px solid #fde68a",
            borderRadius: 6, padding: "10px 12px",
          }}>
            <span style={{ fontSize: 15, flexShrink: 0 }}>⚠</span>
            <span style={{ fontSize: 12, color: "#92400e", lineHeight: 1.55 }}>
              <strong>Action cannot be undone.</strong> After stopping, you will need to redeploy to restart the strategy.
            </span>
          </div>
        </div>
      ),
      btn: "Stop Strategy Now", btnBg: "#dc2626",
    },
    pause: {
      title: "Pause Strategy",
      desc: "Rebalancing will be paused. Current holdings remain unchanged and no new trades will be placed until resumed.",
      btn: "Pause Strategy", btnBg: "#d97706",
    },
    resume: {
      title: "Resume Strategy",
      desc: "Strategy will resume rebalancing on the next scheduled date. No immediate trades will be placed.",
      btn: "Resume Strategy", btnBg: "#16a34a",
    },
    restart: {
      title: "Restart Strategy",
      desc: "Strategy will be restarted from today using your existing configuration. Rebalancing will resume on the next scheduled date.",
      btn: "Restart Strategy", btnBg: "#111",
    },
  };

  const cfg = map[action];
  if (!cfg) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.38)", backdropFilter: "blur(3px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        background: "#fff", borderRadius: 10, padding: "26px 26px 22px",
        width: "100%", maxWidth: 400,
        boxShadow: "0 16px 48px rgba(0,0,0,0.14)", fontFamily: SYS,
        animation: "panelIn 0.2s ease both",
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#111", marginBottom: 10 }}>{cfg.title}</div>
        <div style={{ marginBottom: 22 }}>
          {typeof cfg.desc === "string"
            ? <p style={{ fontSize: 13, color: "#555", lineHeight: 1.6 }}>{cfg.desc}</p>
            : cfg.desc}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "10px", borderRadius: 6, border: "1px solid #ccc", background: "#fff", fontSize: 13, fontWeight: 600, color: "#444", cursor: "pointer", fontFamily: SYS }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ flex: 2, padding: "10px", borderRadius: 6, border: "none", background: cfg.btnBg, fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: SYS }}>
            {cfg.btn}
          </button>
        </div>
      </div>
    </div>
  );
}
