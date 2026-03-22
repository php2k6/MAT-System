import { useState, useEffect } from "react";

// ─── API ──────────────────────────────────────────────────────────────────────
const BASE_URL = import.meta.env.VITE_API_BASE_URL;

async function getJSON(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.detail?.message ||
      data?.detail ||
      data?.message ||
      data?.error ||
      res.statusText ||
      "Request failed";
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

// ─── FONTS ────────────────────────────────────────────────────────────────────
const SYS  = `'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'JetBrains Mono', 'Fira Code', 'Courier New', Courier, monospace`;

// ─── STATUS CONFIG ────────────────────────────────────────────────────────────
const STATUS = {
  done: {
    label: "Done",
    dot: "#16a34a",
    bg: "#f0fdf4",
    border: "#bbf7d0",
    text: "#15803d",
    icon: "✓",
  },
  skipped: {
    label: "Skipped",
    dot: "#d97706",
    bg: "#fffbeb",
    border: "#fde68a",
    text: "#b45309",
    icon: "⊘",
  },
  failed: {
    label: "Failed",
    dot: "#dc2626",
    bg: "#fff5f5",
    border: "#fecaca",
    text: "#b91c1c",
    icon: "✕",
  },
  pending: {
    label: "Pending",
    dot: "#6366f1",
    bg: "#eef2ff",
    border: "#c7d2fe",
    text: "#4338ca",
    icon: "◷",
  },
  running: {
    label: "Running",
    dot: "#0891b2",
    bg: "#ecfeff",
    border: "#a5f3fc",
    text: "#0e7490",
    icon: "↻",
  },
};

// Human-readable skip reason labels
const REASON_LABELS = {
  LC_DETECTED:        "Lower circuit detected",
  UC_DETECTED:        "Upper circuit detected",
  MARKET_CLOSED:      "Market closed",
  BROKER_ERROR:       "Broker error",
  INSUFFICIENT_FUNDS: "Insufficient funds",
  NO_STOCKS_SELECTED: "No stocks selected",
  HOLIDAY:            "Market holiday",
};

function getStatus(s) {
  return STATUS[s?.toLowerCase()] || STATUS.pending;
}

// ─── FORMATTERS ───────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function duration(start, end) {
  if (!start || !end) return null;
  const ms = new Date(end) - new Date(start);
  if (ms < 0) return null;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem  = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

// ─── SMALL COMPONENTS ─────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const s = getStatus(status);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      background: s.bg, border: `1px solid ${s.border}`,
      borderRadius: 6, padding: "3px 9px",
      fontSize: 11, fontWeight: 700, color: s.text,
      fontFamily: SYS, letterSpacing: "0.02em",
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: s.dot, flexShrink: 0,
        ...(status?.toLowerCase() === "running" ? { animation: "pulse 1.4s ease-in-out infinite" } : {}),
      }} />
      {s.label}
    </span>
  );
}

function IDChip({ id }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }
  return (
    <button
      onClick={copy}
      title="Copy full ID"
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        background: "#f5f5f5", border: "1px solid #e5e5e5",
        borderRadius: 5, padding: "3px 8px",
        fontSize: 11, fontFamily: MONO, color: "#555",
        cursor: "pointer", transition: "all 0.14s",
        userSelect: "none",
      }}
    >
      <span style={{ letterSpacing: "0.03em" }}>{id?.slice(0, 8)}…</span>
      <span style={{ fontSize: 10, color: copied ? "#16a34a" : "#aaa" }}>
        {copied ? "✓" : "⎘"}
      </span>
    </button>
  );
}

function EmptyState() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: "72px 24px", gap: 12,
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 14,
        background: "#f5f5f5", border: "1px solid #e8e8e8",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 24,
      }}>⟳</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#222", fontFamily: SYS }}>No rebalances yet</div>
      <div style={{ fontSize: 13, color: "#888", fontFamily: SYS, textAlign: "center", maxWidth: 280, lineHeight: 1.6 }}>
        Rebalance history will appear here once your strategy executes its first cycle.
      </div>
    </div>
  );
}

function NoStrategy() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: "72px 24px", gap: 12,
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 14,
        background: "#fff8f0", border: "1px solid #fed7aa",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 24,
      }}>▶</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#222", fontFamily: SYS }}>No strategy deployed</div>
      <div style={{ fontSize: 13, color: "#888", fontFamily: SYS, textAlign: "center", maxWidth: 300, lineHeight: 1.6 }}>
        Deploy a momentum strategy first. Once live, rebalance history will be tracked here.
      </div>
    </div>
  );
}

function SkeletonRow({ delay = 0 }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "100px 1fr 120px 120px 120px 80px",
      gap: 12, padding: "14px 20px", alignItems: "center",
      borderBottom: "1px solid #f5f5f5",
      animation: `shimmer 1.4s ease-in-out infinite`,
      animationDelay: `${delay}ms`,
    }}>
      {[60, 110, 80, 80, 80, 50].map((w, i) => (
        <div key={i} style={{ height: 12, width: w, background: "#f0f0f0", borderRadius: 4 }} />
      ))}
    </div>
  );
}

// ─── DETAIL DRAWER ────────────────────────────────────────────────────────────
function DetailDrawer({ item, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!item) return null;
  const dur = duration(item.attemptedAt, item.completedAt);

  const rows = [
    ["Rebalance ID",  item.id,                              true],
    ["Status",        item.status,                          false],
    ["Skip Reason",   item.reason ? (REASON_LABELS[item.reason] || item.reason) : "—", false],
    ["Retry Count",   String(item.retryCount ?? 0),         false],
    ["Queued At",     fmtDateTime(item.queuedAt),           false],
    ["Attempted At",  fmtDateTime(item.attemptedAt),        false],
    ["Completed At",  fmtDateTime(item.completedAt),        false],
    ["Duration",      dur || "—",                           false],
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.22)", backdropFilter: "blur(2px)" }}
      />
      {/* Drawer */}
      <div style={{
        position: "fixed", right: 0, top: 0, bottom: 0, zIndex: 201,
        width: "100%", maxWidth: 380,
        background: "#fff", boxShadow: "-8px 0 40px rgba(0,0,0,0.12)",
        display: "flex", flexDirection: "column",
        animation: "slideIn 0.22s ease",
        fontFamily: SYS,
      }}>
        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #f0f0f0", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Rebalance Detail</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#111", letterSpacing: "-0.01em" }}>
              {fmtDate(item.queuedAt)}
            </div>
            <div style={{ marginTop: 8 }}>
              <StatusBadge status={item.status} />
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#aaa", lineHeight: 1, padding: 4, borderRadius: 6, transition: "color 0.13s" }}
          >×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 0 24px" }}>
          {rows.map(([label, val, isMono], i) => (
            <div
              key={label}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                padding: "11px 24px",
                background: i % 2 === 0 ? "#fafafa" : "#fff",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 12, color: "#777", flexShrink: 0 }}>{label}</span>
              <span style={{
                fontSize: 12, fontWeight: 600,
                color: label === "Status" ? getStatus(val).text : "#111",
                fontFamily: isMono ? MONO : SYS,
                textAlign: "right", wordBreak: "break-all",
              }}>
                {val}
              </span>
            </div>
          ))}

          {/* Raw reason code if present */}
          {item.reason && (
            <div style={{ margin: "16px 24px 0", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#b45309", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>Reason Code</div>
              <div style={{ fontSize: 12, fontFamily: MONO, color: "#92400e" }}>{item.reason}</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── STATS STRIP ─────────────────────────────────────────────────────────────
function StatsStrip({ history }) {
  const total   = history.length;
  const done    = history.filter(h => h.status?.toLowerCase() === "done").length;
  const skipped = history.filter(h => h.status?.toLowerCase() === "skipped").length;
  const failed  = history.filter(h => h.status?.toLowerCase() === "failed").length;
  const rate    = total > 0 ? ((done / total) * 100).toFixed(0) : "—";

  const stats = [
    { label: "Total",        value: String(total),          color: "#111"    },
    { label: "Completed",    value: String(done),           color: "#15803d" },
    { label: "Skipped",      value: String(skipped),        color: "#b45309" },
    { label: "Failed",       value: String(failed),         color: "#b91c1c" },
    { label: "Success Rate", value: total > 0 ? `${rate}%` : "—", color: "#111" },
  ];

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(5, 1fr)",
      gap: 1, background: "#e8e8e8",
      border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden",
      marginBottom: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      {stats.map(({ label, value, color }) => (
        <div key={label} style={{ background: "#fff", padding: "14px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: MONO, letterSpacing: "-0.02em", marginBottom: 3 }}>{value}</div>
          <div style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: SYS }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── FILTER BAR ───────────────────────────────────────────────────────────────
function FilterBar({ active, onChange, counts }) {
  const filters = [
    { key: "all",     label: "All"     },
    { key: "done",    label: "Done"    },
    { key: "skipped", label: "Skipped" },
    { key: "failed",  label: "Failed"  },
    { key: "pending", label: "Pending" },
  ];

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
      {filters.map(f => {
        const isActive = active === f.key;
        const count = f.key === "all" ? counts.total : (counts[f.key] ?? 0);
        return (
          <button
            key={f.key}
            onClick={() => onChange(f.key)}
            style={{
              padding: "6px 13px", borderRadius: 7, cursor: "pointer",
              border: `1.5px solid ${isActive ? "#1a1a1a" : "#e0e0e0"}`,
              background: isActive ? "#1a1a1a" : "#fff",
              fontSize: 12, fontWeight: 600,
              color: isActive ? "#fff" : "#555",
              fontFamily: SYS, transition: "all 0.13s",
              display: "flex", alignItems: "center", gap: 6,
            }}
          >
            {f.label}
            <span style={{
              fontSize: 10, fontFamily: MONO, fontWeight: 700,
              background: isActive ? "rgba(255,255,255,0.2)" : "#f0f0f0",
              color: isActive ? "#fff" : "#888",
              padding: "1px 5px", borderRadius: 4,
            }}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── HISTORY ROW ─────────────────────────────────────────────────────────────
function HistoryRow({ item, index, onClick }) {
  const [hovered, setHovered] = useState(false);
  const dur = duration(item.attemptedAt, item.completedAt);
  const s   = getStatus(item.status);

  return (
    <div
      onClick={() => onClick(item)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "34px 110px 1fr 140px 110px 70px 90px",
        gap: 8, alignItems: "center",
        padding: "13px 20px",
        borderBottom: "1px solid #f5f5f5",
        background: hovered ? "#fafafa" : "#fff",
        cursor: "pointer",
        transition: "background 0.12s",
        animation: `fadeRow 0.3s ease both`,
        animationDelay: `${index * 35}ms`,
      }}
    >
      {/* Row number */}
      <span style={{ fontSize: 11, color: "#ccc", fontFamily: MONO, textAlign: "right" }}>
        {String(index + 1).padStart(2, "0")}
      </span>

      {/* Status badge */}
      <StatusBadge status={item.status} />

      {/* Rebalance ID chip */}
      <IDChip id={item.id} />

      {/* Queued date */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#222", fontFamily: SYS }}>{fmtDate(item.queuedAt)}</div>
        <div style={{ fontSize: 10, color: "#aaa", fontFamily: MONO, marginTop: 1 }}>{fmtTime(item.queuedAt)}</div>
      </div>

      {/* Completed date */}
      <div>
        <div style={{ fontSize: 12, color: item.completedAt ? "#555" : "#ccc", fontFamily: SYS }}>
          {item.completedAt ? fmtDate(item.completedAt) : "—"}
        </div>
        <div style={{ fontSize: 10, color: "#aaa", fontFamily: MONO, marginTop: 1 }}>
          {item.completedAt ? fmtTime(item.completedAt) : ""}
        </div>
      </div>

      {/* Duration */}
      <span style={{ fontSize: 11, fontFamily: MONO, color: dur ? "#555" : "#ccc", fontWeight: dur ? 600 : 400 }}>
        {dur || "—"}
      </span>

      {/* Reason / retry */}
      <div style={{ textAlign: "right" }}>
        {item.reason ? (
          <span style={{
            fontSize: 10, fontFamily: MONO, color: s.text,
            background: s.bg, border: `1px solid ${s.border}`,
            borderRadius: 4, padding: "2px 6px",
          }}>{item.reason}</span>
        ) : item.retryCount > 0 ? (
          <span style={{ fontSize: 10, fontFamily: MONO, color: "#888" }}>
            {item.retryCount}× retry
          </span>
        ) : (
          <span style={{ fontSize: 10, color: "#ddd" }}>—</span>
        )}
      </div>
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function History() {
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [data,       setData]       = useState(null); // full API response
  const [filter,     setFilter]     = useState("all");
  const [selected,   setSelected]   = useState(null);
  const [mounted,    setMounted]    = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 40);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    fetchHistory();
  }, []);

  async function fetchHistory() {
    setLoading(true);
    setError(null);
    try {
      const res = await getJSON(`${BASE_URL}/strategy/rebalance-history`);
      setData(res);
    } catch (err) {
      setError(err.message || "Failed to load rebalance history.");
    } finally {
      setLoading(false);
    }
  }

  const history = data?.history ?? [];

  // Filter counts
  const counts = {
    total:   history.length,
    done:    history.filter(h => h.status?.toLowerCase() === "done").length,
    skipped: history.filter(h => h.status?.toLowerCase() === "skipped").length,
    failed:  history.filter(h => h.status?.toLowerCase() === "failed").length,
    pending: history.filter(h => h.status?.toLowerCase() === "pending").length,
    running: history.filter(h => h.status?.toLowerCase() === "running").length,
  };

  const filtered = filter === "all"
    ? history
    : history.filter(h => h.status?.toLowerCase() === filter);

  // Most recent queued date
  const latestRun = history.length > 0
    ? history.reduce((a, b) => new Date(a.queuedAt) > new Date(b.queuedAt) ? a : b)
    : null;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .hist-root  { min-height: calc(100vh - 60px); background: #f3f3f3; padding: 28px 20px 72px; font-family: ${SYS}; }
        .hist-wrap  { max-width: 1100px; margin: 0 auto; opacity: 0; transform: translateY(10px); transition: opacity 0.35s ease, transform 0.35s ease; }
        .hist-wrap.mounted { opacity: 1; transform: translateY(0); }

        @media (max-width: 700px) {
          .hist-root { padding: 16px 14px 60px; }
          .stats-strip { grid-template-columns: repeat(3, 1fr) !important; }
          .tbl-row { grid-template-columns: 24px 90px 1fr 80px !important; }
          .tbl-row .col-completed,
          .tbl-row .col-dur,
          .tbl-row .col-reason { display: none; }
          .tbl-head .col-completed,
          .tbl-head .col-dur,
          .tbl-head .col-reason { display: none; }
        }

        @keyframes shimmer { 0%,100%{opacity:1} 50%{opacity:0.45} }
        @keyframes pulse   { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.6;transform:scale(1.25)} }
        @keyframes fadeRow { from{opacity:0;transform:translateX(-6px)} to{opacity:1;transform:translateX(0)} }
        @keyframes slideIn { from{transform:translateX(100%)} to{transform:translateX(0)} }
        @keyframes spin    { to{transform:rotate(360deg)} }

        .refresh-btn:hover { background: #f0f0f0 !important; border-color: #999 !important; }
        .refresh-btn:active { transform: scale(0.96); }

        .tbl-head {
          display: grid;
          grid-template-columns: 34px 110px 1fr 140px 110px 70px 90px;
          gap: 8px; padding: 9px 20px;
          background: #fafafa;
          border-bottom: 1px solid #ebebeb;
          border-top: 1px solid #ebebeb;
        }
        .th { font-size: 10px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 0.07em; font-family: ${SYS}; }
        .th.right { text-align: right; }
      `}</style>

      {/* Detail drawer */}
      {selected && (
        <DetailDrawer item={selected} onClose={() => setSelected(null)} />
      )}

      <div className="hist-root">
        <div className={`hist-wrap ${mounted ? "mounted" : ""}`}>

          {/* ── Page Header ── */}
          <div style={{ marginBottom: 22, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>Strategy Execution</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: "#111", marginBottom: 4, letterSpacing: "-0.02em" }}>Rebalance History</div>
              <div style={{ fontSize: 13, color: "#666", lineHeight: 1.6 }}>
                Full log of every rebalance cycle — status, timing, and skip reasons.
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {/* Strategy ID pill */}
              {data?.strategyId && (
                <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "8px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em" }}>Strategy ID</span>
                  <span style={{ fontSize: 11, fontFamily: MONO, color: "#555", letterSpacing: "0.03em" }}>{data.strategyId.slice(0, 18)}…</span>
                </div>
              )}

              {/* Last run pill */}
              {latestRun && (
                <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "8px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em" }}>Last Run</span>
                  <span style={{ fontSize: 11, fontFamily: MONO, color: "#555" }}>{fmtDate(latestRun.queuedAt)}</span>
                </div>
              )}

              {/* Refresh button */}
              <button
                className="refresh-btn"
                onClick={fetchHistory}
                disabled={loading}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "9px 16px", borderRadius: 8,
                  border: "1.5px solid #d0d0d0", background: "#fff",
                  fontSize: 12, fontWeight: 700, color: "#333",
                  cursor: loading ? "not-allowed" : "pointer",
                  fontFamily: SYS, transition: "all 0.13s",
                  opacity: loading ? 0.5 : 1,
                }}
              >
                <span style={{
                  display: "inline-block",
                  animation: loading ? "spin 0.9s linear infinite" : "none",
                  fontSize: 14, lineHeight: 1,
                }}>⟳</span>
                Refresh
              </button>
            </div>
          </div>

          {/* ── Error Banner ── */}
          {error && (
            <div style={{
              background: "#fff5f5", border: "1px solid #fca5a5", borderRadius: 9,
              padding: "12px 16px", marginBottom: 14,
              display: "flex", justifyContent: "space-between", alignItems: "flex-start",
              fontFamily: SYS,
            }}>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ color: "#c62828", flexShrink: 0 }}>✕</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#c62828", marginBottom: 2 }}>Failed to Load</div>
                  <div style={{ fontSize: 12, color: "#7f1d1d", lineHeight: 1.5 }}>{error}</div>
                </div>
              </div>
              <button
                onClick={() => setError(null)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#c62828", fontSize: 20, lineHeight: 1 }}
              >×</button>
            </div>
          )}

          {/* ── Loading skeletons ── */}
          {loading && (
            <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
              {[0, 80, 160, 240, 320].map(d => <SkeletonRow key={d} delay={d} />)}
            </div>
          )}

          {/* ── No strategy ── */}
          {!loading && data && !data.strategyDeployed && (
            <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
              <NoStrategy />
            </div>
          )}

          {/* ── Main content (strategy exists) ── */}
          {!loading && data?.strategyDeployed && (
            <>
              {/* Stats strip */}
              {history.length > 0 && (
                <div className="stats-strip" style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(5, 1fr)",
                  gap: 1, background: "#e8e8e8",
                  border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden",
                  marginBottom: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}>
                  {[
                    { label: "Total",        value: String(history.length),   color: "#111"    },
                    { label: "Completed",    value: String(counts.done),      color: "#15803d" },
                    { label: "Skipped",      value: String(counts.skipped),   color: "#b45309" },
                    { label: "Failed",       value: String(counts.failed),    color: "#b91c1c" },
                    { label: "Success Rate", value: history.length > 0 ? `${((counts.done / history.length) * 100).toFixed(0)}%` : "—", color: "#111" },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ background: "#fff", padding: "14px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: MONO, letterSpacing: "-0.02em", marginBottom: 3 }}>{value}</div>
                      <div style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: SYS }}>{label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Filter bar */}
              <FilterBar active={filter} onChange={setFilter} counts={counts} />

              {/* Table card */}
              <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>

                {/* Table header */}
                {history.length > 0 && (
                  <div className="tbl-head">
                    <span className="th">#</span>
                    <span className="th">Status</span>
                    <span className="th">ID</span>
                    <span className="th">Queued</span>
                    <span className="th col-completed">Completed</span>
                    <span className="th col-dur">Duration</span>
                    <span className="th right col-reason">Reason</span>
                  </div>
                )}

                {/* Rows */}
                {filtered.length > 0 ? (
                  filtered.map((item, i) => (
                    <div key={item.id} className="tbl-row">
                      <HistoryRow item={item} index={i} onClick={setSelected} />
                    </div>
                  ))
                ) : history.length > 0 ? (
                  // Has history but filter returns nothing
                  <div style={{ padding: "40px 24px", textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "#aaa", fontFamily: SYS }}>No {filter} rebalances found.</div>
                  </div>
                ) : (
                  <EmptyState />
                )}

                {/* Footer */}
                {filtered.length > 0 && (
                  <div style={{
                    padding: "10px 20px",
                    borderTop: "1px solid #f0f0f0",
                    background: "#fafafa",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <span style={{ fontSize: 11, color: "#bbb", fontFamily: SYS }}>
                      Click any row to view full details
                    </span>
                    <span style={{ fontSize: 11, color: "#bbb", fontFamily: MONO }}>
                      {filtered.length} of {history.length} records
                    </span>
                  </div>
                )}
              </div>
            </>
          )}

        </div>
      </div>
    </>
  );
}