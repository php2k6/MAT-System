import { useState, useEffect, useCallback } from "react";

// ─── API ──────────────────────────────────────────────────────────────────────
const BASE_URL = import.meta.env.VITE_API_BASE_URL;

async function getJSON(url) {
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
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

async function postJSON(url, body = {}) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

// ─── STATUS CONFIG (new API statuses) ─────────────────────────────────────────
// API statuses: completed | action_required | failed | completed_ignored | skipped
const STATUS_MAP = {
  completed: {
    label: "Completed",
    dot: "#16a34a",
    bg: "#f0fdf4",
    border: "#bbf7d0",
    text: "#15803d",
  },
  action_required: {
    label: "Action Required",
    dot: "#dc2626",
    bg: "#fff5f5",
    border: "#fecaca",
    text: "#b91c1c",
  },
  failed: {
    label: "Failed",
    dot: "#dc2626",
    bg: "#fff5f5",
    border: "#fecaca",
    text: "#b91c1c",
  },
  completed_ignored: {
    label: "Closed",
    dot: "#6b7280",
    bg: "#f9fafb",
    border: "#e5e7eb",
    text: "#374151",
  },
  skipped: {
    label: "Skipped",
    dot: "#d97706",
    bg: "#fffbeb",
    border: "#fde68a",
    text: "#b45309",
  },
};

const FALLBACK_STATUS = {
  label: "Unknown",
  dot: "#9ca3af",
  bg: "#f9fafb",
  border: "#e5e7eb",
  text: "#6b7280",
};

function getStatusCfg(s) {
  return STATUS_MAP[s?.toLowerCase()] || FALLBACK_STATUS;
}

// ─── LEG STATUS ───────────────────────────────────────────────────────────────
const LEG_STATUS = {
  planned:  { label: "Planned",  color: "#6b7280", bg: "#f9fafb" },
  placed:   { label: "Placed",   color: "#0891b2", bg: "#ecfeff" },
  partial:  { label: "Partial",  color: "#d97706", bg: "#fffbeb" },
  filled:   { label: "Filled",   color: "#16a34a", bg: "#f0fdf4" },
  failed:   { label: "Failed",   color: "#dc2626", bg: "#fff5f5" },
  ignored:  { label: "Ignored",  color: "#9ca3af", bg: "#f3f4f6" },
};

function getLegStatusCfg(s) {
  return LEG_STATUS[s?.toLowerCase()] || { label: s || "—", color: "#6b7280", bg: "#f9fafb" };
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

function fmtCurrency(val) {
  if (val === null || val === undefined) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR",
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(val);
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

function fmtSymbol(sym) {
  // NSE:SBIN-EQ → SBIN
  if (!sym) return "—";
  return sym.split(":")[1]?.split("-")[0] || sym;
}

// ─── SMALL COMPONENTS ─────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const s = getStatusCfg(status);
  const isActionReq = status === "action_required";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      background: s.bg, border: `1px solid ${s.border}`,
      borderRadius: 6, padding: "3px 9px",
      fontSize: 11, fontWeight: 700, color: s.text,
      fontFamily: SYS, letterSpacing: "0.02em",
      whiteSpace: "nowrap",
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: s.dot, flexShrink: 0,
        ...(isActionReq ? { animation: "pulse 1.4s ease-in-out infinite" } : {}),
      }} />
      {s.label}
    </span>
  );
}

function LegStatusBadge({ status }) {
  const c = getLegStatusCfg(status);
  return (
    <span style={{
      display: "inline-block",
      background: c.bg, color: c.color,
      fontSize: 10, fontWeight: 700,
      padding: "2px 7px", borderRadius: 4,
      fontFamily: SYS, letterSpacing: "0.04em",
    }}>{c.label}</span>
  );
}

function IDChip({ id }) {
  const [copied, setCopied] = useState(false);
  function copy(e) {
    e.stopPropagation();
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
      display: "grid", gridTemplateColumns: "34px 130px 1fr 140px 120px 80px 100px",
      gap: 12, padding: "14px 20px", alignItems: "center",
      borderBottom: "1px solid #f5f5f5",
      animation: `shimmer 1.4s ease-in-out infinite`,
      animationDelay: `${delay}ms`,
    }}>
      {[24, 100, 80, 90, 90, 60, 60].map((w, i) => (
        <div key={i} style={{ height: 12, width: w, background: "#f0f0f0", borderRadius: 4 }} />
      ))}
    </div>
  );
}

// ─── ACTION BUTTON ────────────────────────────────────────────────────────────
function ActionButton({ label, variant = "default", onClick, loading, disabled }) {
  const styles = {
    repair: {
      background: loading ? "#e0f2fe" : "#0ea5e9",
      color: "#fff",
      border: "1.5px solid #0284c7",
      hoverBg: "#0284c7",
    },
    archive: {
      background: "#fff",
      color: "#374151",
      border: "1.5px solid #d1d5db",
      hoverBg: "#f9fafb",
    },
    default: {
      background: "#fff",
      color: "#374151",
      border: "1.5px solid #d1d5db",
      hoverBg: "#f9fafb",
    },
  };
  const s = styles[variant];
  const [hov, setHov] = useState(false);

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "7px 14px", borderRadius: 7,
        border: s.border,
        background: hov && !disabled && !loading ? s.hoverBg : s.background,
        color: disabled ? "#aaa" : s.color,
        fontSize: 12, fontWeight: 700, fontFamily: SYS,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        transition: "all 0.13s",
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {loading && (
        <span style={{ display: "inline-block", animation: "spin 0.8s linear infinite", fontSize: 13 }}>⟳</span>
      )}
      {label}
    </button>
  );
}

// ─── LEGS TABLE ───────────────────────────────────────────────────────────────
function LegsTable({ legs }) {
  if (!legs || legs.length === 0) {
    return (
      <div style={{ padding: "18px 0", textAlign: "center", fontSize: 12, color: "#bbb", fontFamily: SYS }}>
        No legs recorded for this run.
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: SYS }}>
        <thead>
          <tr style={{ background: "#f9fafb", borderBottom: "1px solid #f0f0f0" }}>
            {["Phase", "Symbol", "Req. Qty", "Filled", "Remaining", "Status", "Attempt", "Error"].map(h => (
              <th key={h} style={{
                padding: "7px 10px", textAlign: "left",
                fontSize: 10, fontWeight: 700, color: "#9ca3af",
                textTransform: "uppercase", letterSpacing: "0.06em",
                whiteSpace: "nowrap",
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {legs.map((leg, i) => (
            <tr key={leg.id || i} style={{ borderBottom: "1px solid #f5f5f5", background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
              <td style={{ padding: "8px 10px" }}>
                <span style={{
                  display: "inline-block",
                  fontSize: 10, fontWeight: 700,
                  padding: "2px 7px", borderRadius: 4,
                  background: leg.phase === "sell" ? "#fff5f5" : "#f0fdf4",
                  color: leg.phase === "sell" ? "#b91c1c" : "#15803d",
                  textTransform: "uppercase", letterSpacing: "0.04em",
                }}>{leg.phase}</span>
              </td>
              <td style={{ padding: "8px 10px", fontFamily: MONO, color: "#333", fontWeight: 600, fontSize: 11 }}>
                {fmtSymbol(leg.symbol)}
              </td>
              <td style={{ padding: "8px 10px", fontFamily: MONO, color: "#555" }}>{leg.requestedQty ?? "—"}</td>
              <td style={{ padding: "8px 10px", fontFamily: MONO, color: leg.filledQty > 0 ? "#15803d" : "#9ca3af" }}>
                {leg.filledQty ?? "—"}
              </td>
              <td style={{ padding: "8px 10px", fontFamily: MONO, color: leg.remainingQty > 0 ? "#b91c1c" : "#9ca3af" }}>
                {leg.remainingQty ?? "—"}
              </td>
              <td style={{ padding: "8px 10px" }}>
                <LegStatusBadge status={leg.status} />
              </td>
              <td style={{ padding: "8px 10px", fontFamily: MONO, color: "#6b7280", fontSize: 10 }}>
                #{leg.attemptNo ?? 1}
              </td>
              <td style={{ padding: "8px 10px", maxWidth: 160 }}>
                {leg.errorMessage ? (
                  <span
                    title={leg.errorMessage}
                    style={{
                      fontSize: 10, color: "#b91c1c", fontFamily: MONO,
                      display: "block", overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap",
                      maxWidth: 150,
                    }}
                  >{leg.errorMessage}</span>
                ) : (
                  <span style={{ color: "#d1d5db", fontSize: 10 }}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── LEGS META STRIP ─────────────────────────────────────────────────────────
function LegsMeta({ meta }) {
  if (!meta) return null;
  const items = [
    { label: "Total",           value: meta.total ?? 0,                  color: "#374151" },
    { label: "Unresolved",      value: meta.unresolved ?? 0,             color: meta.unresolved > 0 ? "#b91c1c" : "#16a34a" },
    { label: "Retryable",       value: meta.retryableUnresolved ?? 0,    color: "#0891b2" },
    { label: "Non-Retryable",   value: meta.nonRetryableUnresolved ?? 0, color: meta.nonRetryableUnresolved > 0 ? "#dc2626" : "#9ca3af" },
  ];
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
      gap: 1, background: "#f0f0f0",
      border: "1px solid #e8e8e8", borderRadius: 8, overflow: "hidden",
      marginBottom: 12,
    }}>
      {items.map(({ label, value, color }) => (
        <div key={label} style={{ background: "#fff", padding: "10px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: MONO, letterSpacing: "-0.02em", marginBottom: 2 }}>{value}</div>
          <div style={{ fontSize: 9, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: SYS }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── PORTFOLIO DIFF ───────────────────────────────────────────────────────────
function PortfolioDiff({ preCash, postCash, preTotal, postTotal }) {
  const cashDiff  = (postCash ?? 0) - (preCash ?? 0);
  const totalDiff = (postTotal ?? 0) - (preTotal ?? 0);

  const row = (label, pre, post, diff) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 14px", borderBottom: "1px solid #f5f5f5" }}>
      <span style={{ fontSize: 12, color: "#777", fontFamily: SYS }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 16, textAlign: "right" }}>
        <span style={{ fontSize: 11, color: "#aaa", fontFamily: MONO }}>{fmtCurrency(pre)}</span>
        <span style={{ fontSize: 11, color: "#ccc" }}>→</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#111", fontFamily: MONO }}>{fmtCurrency(post)}</span>
        {diff !== 0 && (
          <span style={{
            fontSize: 10, fontWeight: 700, fontFamily: MONO,
            color: diff > 0 ? "#15803d" : "#b91c1c",
            minWidth: 60, textAlign: "right",
          }}>
            {diff > 0 ? "+" : ""}{fmtCurrency(diff)}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ border: "1px solid #e8e8e8", borderRadius: 8, overflow: "hidden", background: "#fff", marginBottom: 12 }}>
      <div style={{ padding: "8px 14px", background: "#fafafa", borderBottom: "1px solid #f0f0f0" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: SYS }}>Portfolio Snapshot</span>
      </div>
      {row("Cash",        preCash,  postCash,  cashDiff)}
      {row("Total Value", preTotal, postTotal, totalDiff)}
    </div>
  );
}

// ─── DETAIL DRAWER ────────────────────────────────────────────────────────────
function DetailDrawer({ historyId, onClose, onActionSuccess }) {
  const [detail,       setDetail]       = useState(null);
  const [loadingDetail,setLoadingDetail] = useState(true);
  const [detailError,  setDetailError]  = useState(null);
  const [repairing,    setRepairing]    = useState(false);
  const [archiving,    setArchiving]    = useState(false);
  const [actionMsg,    setActionMsg]    = useState(null); // { type: 'success'|'error', text }
  const [activeTab,    setActiveTab]    = useState("overview"); // overview | legs

  const fetchDetail = useCallback(async () => {
    if (!historyId) return;
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const res = await getJSON(`${BASE_URL}/strategy/rebalance-history/${historyId}`);
      setDetail(res.history);
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setLoadingDetail(false);
    }
  }, [historyId]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleRepair() {
    setRepairing(true);
    setActionMsg(null);
    try {
      const res = await postJSON(`${BASE_URL}/strategy/rebalance-history/${historyId}/repair`, {});
      setActionMsg({ type: "success", text: res.message || `Repair attempted. Status: ${res.status}. Repaired: ${res.repairedLegs ?? 0} leg(s).` });
      await fetchDetail();
      onActionSuccess?.();
    } catch (err) {
      setActionMsg({ type: "error", text: err.message });
    } finally {
      setRepairing(false);
    }
  }

  async function handleArchive() {
    setArchiving(true);
    setActionMsg(null);
    try {
      const res = await postJSON(`${BASE_URL}/strategy/rebalance-history/${historyId}/archive`, {});
      setActionMsg({ type: "success", text: res.message || `Archived. ${res.ignoredLegs ?? 0} leg(s) ignored.` });
      await fetchDetail();
      onActionSuccess?.();
    } catch (err) {
      setActionMsg({ type: "error", text: err.message });
    } finally {
      setArchiving(false);
    }
  }

  const item = detail;
  const canRepair  = item?.legsMeta?.canRepair  ?? false;
  const canArchive = item?.legsMeta?.canArchive ?? false;
  const showActions = canRepair || canArchive;
  const dur = duration(item?.startedAt, item?.completedAt);

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "legs",     label: `Legs${item?.legs?.length > 0 ? ` (${item.legs.length})` : ""}` },
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
        width: "100%", maxWidth: 480,
        background: "#fff", boxShadow: "-8px 0 40px rgba(0,0,0,0.12)",
        display: "flex", flexDirection: "column",
        animation: "slideIn 0.22s ease",
        fontFamily: SYS,
      }}>
        {/* Header */}
        <div style={{ padding: "20px 24px 0", borderBottom: "1px solid #f0f0f0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>
                Rebalance Detail
              </div>
              <div style={{ fontSize: 17, fontWeight: 700, color: "#111", letterSpacing: "-0.01em" }}>
                {item ? fmtDate(item.startedAt) : "Loading…"}
              </div>
              {item && (
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  <StatusBadge status={item.status} />
                  {dur && <span style={{ fontSize: 11, color: "#aaa", fontFamily: MONO }}>{dur}</span>}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#aaa", lineHeight: 1, padding: 4, borderRadius: 6 }}
            >×</button>
          </div>

          {/* Tabs */}
          {item && (
            <div style={{ display: "flex", gap: 0, borderBottom: "none" }}>
              {tabs.map(t => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  style={{
                    padding: "8px 16px 10px",
                    background: "none", border: "none", cursor: "pointer",
                    fontSize: 12, fontWeight: 700, fontFamily: SYS,
                    color: activeTab === t.key ? "#111" : "#aaa",
                    borderBottom: `2px solid ${activeTab === t.key ? "#111" : "transparent"}`,
                    transition: "all 0.13s",
                  }}
                >{t.label}</button>
              ))}
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 24px" }}>

          {/* Loading */}
          {loadingDetail && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[80, 110, 90, 120, 80].map((w, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #f5f5f5" }}>
                  <div style={{ height: 11, width: 80, background: "#f0f0f0", borderRadius: 4, animation: "shimmer 1.4s ease-in-out infinite" }} />
                  <div style={{ height: 11, width: w, background: "#f0f0f0", borderRadius: 4, animation: "shimmer 1.4s ease-in-out infinite", animationDelay: `${i * 80}ms` }} />
                </div>
              ))}
            </div>
          )}

          {/* Detail error */}
          {detailError && (
            <div style={{ background: "#fff5f5", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 14px", fontSize: 12, color: "#b91c1c", fontFamily: SYS }}>
              {detailError}
            </div>
          )}

          {/* Action feedback */}
          {actionMsg && (
            <div style={{
              background: actionMsg.type === "success" ? "#f0fdf4" : "#fff5f5",
              border: `1px solid ${actionMsg.type === "success" ? "#bbf7d0" : "#fca5a5"}`,
              borderRadius: 8, padding: "10px 14px", marginBottom: 12,
              fontSize: 12, fontFamily: SYS,
              color: actionMsg.type === "success" ? "#15803d" : "#b91c1c",
              display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8,
            }}>
              <span>{actionMsg.text}</span>
              <button onClick={() => setActionMsg(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: "inherit", lineHeight: 1, flexShrink: 0 }}>×</button>
            </div>
          )}

          {/* ── OVERVIEW TAB ── */}
          {item && !loadingDetail && activeTab === "overview" && (
            <>
              {/* Actions (action_required only) */}
              {showActions && (
                <div style={{
                  background: "#fff8f0", border: "1px solid #fed7aa",
                  borderRadius: 8, padding: "12px 14px",
                  marginBottom: 14,
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#b45309", marginBottom: 8, fontFamily: SYS }}>
                    ⚠ This run has {item.legsMeta?.unresolved ?? 0} unresolved leg(s)
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {canRepair && (
                      <ActionButton
                        label={repairing ? "Repairing…" : "Repair"}
                        variant="repair"
                        loading={repairing}
                        disabled={archiving}
                        onClick={handleRepair}
                      />
                    )}
                    {canArchive && (
                      <ActionButton
                        label={archiving ? "Archiving…" : "Archive"}
                        variant="archive"
                        loading={archiving}
                        disabled={repairing}
                        onClick={handleArchive}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Portfolio diff */}
              <PortfolioDiff
                preCash={item.preCash}
                postCash={item.postCash}
                preTotal={item.preTotal}
                postTotal={item.postTotal}
              />

              {/* Legs meta mini strip */}
              {item.legsMeta && <LegsMeta meta={item.legsMeta} />}

              {/* Detail rows */}
              {[
                ["Rebalance ID",  item.id,                          true],
                ["Strategy ID",   item.strategyId,                  true],
                ["Queue ID",      item.queueId || "—",              true],
                ["Status",        <StatusBadge status={item.status} />, false],
                ["Skip Reason",   item.reason || "—",               false],
                ["Started At",    fmtDateTime(item.startedAt),      false],
                ["Completed At",  fmtDateTime(item.completedAt),    false],
                ["Duration",      dur || "—",                       false],
              ].map(([label, val, isMono], i) => (
                <div
                  key={label}
                  style={{
                    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                    padding: "10px 0",
                    borderBottom: "1px solid #f5f5f5",
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: 12, color: "#777", flexShrink: 0, fontFamily: SYS }}>{label}</span>
                  <span style={{
                    fontSize: 12, fontWeight: 600,
                    color: "#111",
                    fontFamily: isMono ? MONO : SYS,
                    textAlign: "right", wordBreak: "break-all",
                  }}>
                    {val}
                  </span>
                </div>
              ))}

              {/* Repair/archive history from summary */}
              {(item.summary?.repairs?.length > 0 || item.summary?.archives?.length > 0) && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, fontFamily: SYS }}>Action Log</div>
                  {(item.summary?.repairs || []).map((r, i) => (
                    <div key={i} style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 7, padding: "9px 12px", marginBottom: 7 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#15803d", fontFamily: SYS, marginBottom: 3 }}>Repair — {fmtDateTime(r.at)}</div>
                      <div style={{ fontSize: 11, color: "#374151", fontFamily: SYS }}>
                        Repaired: {r.repairedLegs}, Sell placed: {r.sellPlaced}, Buy placed: {r.buyPlaced}, Unresolved after: {r.unresolvedAfter}
                      </div>
                      {r.note && <div style={{ fontSize: 11, color: "#6b7280", fontFamily: SYS, marginTop: 3 }}>Note: {r.note}</div>}
                    </div>
                  ))}
                  {(item.summary?.archives || []).map((a, i) => (
                    <div key={i} style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 7, padding: "9px 12px", marginBottom: 7 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", fontFamily: SYS, marginBottom: 3 }}>Archive — {fmtDateTime(a.at)}</div>
                      <div style={{ fontSize: 11, color: "#374151", fontFamily: SYS }}>Ignored legs: {a.ignoredLegs}</div>
                      {a.note && <div style={{ fontSize: 11, color: "#6b7280", fontFamily: SYS, marginTop: 3 }}>Note: {a.note}</div>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── LEGS TAB ── */}
          {item && !loadingDetail && activeTab === "legs" && (
            <>
              {showActions && (
                <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
                  {canRepair && (
                    <ActionButton
                      label={repairing ? "Repairing…" : "Repair Legs"}
                      variant="repair"
                      loading={repairing}
                      disabled={archiving}
                      onClick={handleRepair}
                    />
                  )}
                  {canArchive && (
                    <ActionButton
                      label={archiving ? "Archiving…" : "Archive Run"}
                      variant="archive"
                      loading={archiving}
                      disabled={repairing}
                      onClick={handleArchive}
                    />
                  )}
                </div>
              )}
              <LegsTable legs={item.legs} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ─── FILTER BAR ───────────────────────────────────────────────────────────────
function FilterBar({ active, onChange, counts }) {
  // New API status buckets
  const filters = [
    { key: "all",               label: "All"              },
    { key: "action_required",   label: "Action Required"  },
    { key: "completed",         label: "Completed"        },
    { key: "completed_ignored", label: "Closed"           },
    { key: "failed",            label: "Failed"           },
    { key: "skipped",           label: "Skipped"          },
  ];

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
      {filters.map(f => {
        const isActive = active === f.key;
        const count    = f.key === "all" ? counts.total : (counts[f.key] ?? 0);
        if (f.key !== "all" && count === 0) return null; // hide empty buckets
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
  const dur     = duration(item.startedAt, item.completedAt);
  const meta    = item.legsMeta;
  const hasIssue = item.status === "action_required";

  return (
    <div
      onClick={() => onClick(item.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "34px 140px 1fr 140px 110px 80px 90px",
        gap: 8, alignItems: "center",
        padding: "13px 20px",
        borderBottom: "1px solid #f5f5f5",
        background: hovered ? "#fafafa" : (hasIssue ? "#fffcfc" : "#fff"),
        cursor: "pointer",
        transition: "background 0.12s",
        animation: `fadeRow 0.3s ease both`,
        animationDelay: `${index * 35}ms`,
        borderLeft: hasIssue ? "3px solid #fca5a5" : "3px solid transparent",
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

      {/* Started date */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#222", fontFamily: SYS }}>{fmtDate(item.startedAt)}</div>
        <div style={{ fontSize: 10, color: "#aaa", fontFamily: MONO, marginTop: 1 }}>{fmtTime(item.startedAt)}</div>
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

      {/* Legs meta / reason */}
      <div style={{ textAlign: "right" }}>
        {meta && meta.unresolved > 0 ? (
          <span style={{
            fontSize: 10, fontFamily: MONO, color: "#b91c1c",
            background: "#fff5f5", border: "1px solid #fecaca",
            borderRadius: 4, padding: "2px 6px", whiteSpace: "nowrap",
          }}>{meta.unresolved} unresolved</span>
        ) : item.reason ? (
          <span style={{
            fontSize: 10, fontFamily: MONO,
            color: getStatusCfg(item.status).text,
            background: getStatusCfg(item.status).bg,
            border: `1px solid ${getStatusCfg(item.status).border}`,
            borderRadius: 4, padding: "2px 6px",
          }}>{item.reason}</span>
        ) : meta && meta.total > 0 ? (
          <span style={{ fontSize: 10, fontFamily: MONO, color: "#aaa" }}>
            {meta.total} leg{meta.total !== 1 ? "s" : ""}
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
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [data,     setData]     = useState(null);
  const [filter,   setFilter]   = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [mounted,  setMounted]  = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 40);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => { fetchHistory(); }, []);

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

  // Count per new status bucket
  const counts = {
    total:             history.length,
    completed:         history.filter(h => h.status === "completed").length,
    action_required:   history.filter(h => h.status === "action_required").length,
    failed:            history.filter(h => h.status === "failed").length,
    completed_ignored: history.filter(h => h.status === "completed_ignored").length,
    skipped:           history.filter(h => h.status === "skipped").length,
  };

  const filtered = filter === "all"
    ? history
    : history.filter(h => h.status === filter);

  const latestRun = history.length > 0
    ? history.reduce((a, b) => new Date(a.startedAt) > new Date(b.startedAt) ? a : b)
    : null;

  // Success rate = completed / (completed + failed + completed_ignored)
  const attempted = counts.completed + counts.failed + counts.completed_ignored;
  const successRate = attempted > 0 ? ((counts.completed / attempted) * 100).toFixed(0) : "—";

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
          .tbl-row-inner { grid-template-columns: 24px 120px 1fr 80px !important; }
          .col-completed, .col-dur, .col-meta { display: none; }
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
          grid-template-columns: 34px 140px 1fr 140px 110px 80px 90px;
          gap: 8px; padding: 9px 20px;
          background: #fafafa;
          border-bottom: 1px solid #ebebeb;
          border-top: 1px solid #ebebeb;
        }
        .th { font-size: 10px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 0.07em; font-family: ${SYS}; }
        .th.right { text-align: right; }
      `}</style>

      {/* Detail drawer */}
      {selectedId && (
        <DetailDrawer
          historyId={selectedId}
          onClose={() => setSelectedId(null)}
          onActionSuccess={fetchHistory}
        />
      )}

      <div className="hist-root">
        <div className={`hist-wrap ${mounted ? "mounted" : ""}`}>

          {/* ── Page Header ── */}
          <div style={{ marginBottom: 22, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>Strategy Execution</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: "#111", marginBottom: 4, letterSpacing: "-0.02em" }}>Rebalance History</div>
              <div style={{ fontSize: 13, color: "#666", lineHeight: 1.6 }}>
                Full log of every rebalance cycle — status, timing, legs, and skip reasons.
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {data?.strategyId && (
                <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "8px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em" }}>Strategy ID</span>
                  <span style={{ fontSize: 11, fontFamily: MONO, color: "#555", letterSpacing: "0.03em" }}>{data.strategyId.slice(0, 18)}…</span>
                </div>
              )}
              {latestRun && (
                <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "8px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em" }}>Last Run</span>
                  <span style={{ fontSize: 11, fontFamily: MONO, color: "#555" }}>{fmtDate(latestRun.startedAt)}</span>
                </div>
              )}
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
                <span style={{ display: "inline-block", animation: loading ? "spin 0.9s linear infinite" : "none", fontSize: 14, lineHeight: 1 }}>⟳</span>
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
              <button onClick={() => setError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#c62828", fontSize: 20, lineHeight: 1 }}>×</button>
            </div>
          )}

          {/* ── Loading ── */}
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

          {/* ── Main content ── */}
          {!loading && data?.strategyDeployed && (
            <>
              {/* Stats strip */}
              {history.length > 0 && (
                <div className="stats-strip" style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(6, 1fr)",
                  gap: 1, background: "#e8e8e8",
                  border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden",
                  marginBottom: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}>
                  {[
                    { label: "Total",           value: String(counts.total),           color: "#111"    },
                    { label: "Completed",        value: String(counts.completed),       color: "#15803d" },
                    { label: "Action Required",  value: String(counts.action_required), color: counts.action_required > 0 ? "#b91c1c" : "#111" },
                    { label: "Failed",           value: String(counts.failed),          color: counts.failed > 0 ? "#b91c1c" : "#111" },
                    { label: "Skipped",          value: String(counts.skipped),         color: "#b45309" },
                    { label: "Success Rate",     value: attempted > 0 ? `${successRate}%` : "—", color: "#111" },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ background: "#fff", padding: "14px 8px", textAlign: "center" }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: MONO, letterSpacing: "-0.02em", marginBottom: 3 }}>{value}</div>
                      <div style={{ fontSize: 9, color: "#999", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: SYS }}>{label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Filter bar */}
              <FilterBar active={filter} onChange={setFilter} counts={counts} />

              {/* Table card */}
              <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>

                {history.length > 0 && (
                  <div className="tbl-head">
                    <span className="th">#</span>
                    <span className="th">Status</span>
                    <span className="th">ID</span>
                    <span className="th">Started</span>
                    <span className="th col-completed">Completed</span>
                    <span className="th col-dur">Duration</span>
                    <span className="th right col-meta">Legs / Reason</span>
                  </div>
                )}

                {filtered.length > 0 ? (
                  filtered.map((item, i) => (
                    <div key={item.id} className="tbl-row-inner">
                      <HistoryRow item={item} index={i} onClick={setSelectedId} />
                    </div>
                  ))
                ) : history.length > 0 ? (
                  <div style={{ padding: "40px 24px", textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "#aaa", fontFamily: SYS }}>No {filter.replace("_", " ")} rebalances found.</div>
                  </div>
                ) : (
                  <EmptyState />
                )}

                {filtered.length > 0 && (
                  <div style={{
                    padding: "10px 20px",
                    borderTop: "1px solid #f0f0f0",
                    background: "#fafafa",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <span style={{ fontSize: 11, color: "#bbb", fontFamily: SYS }}>Click any row to view details, legs, and actions</span>
                    <span style={{ fontSize: 11, color: "#bbb", fontFamily: MONO }}>{filtered.length} of {history.length} records</span>
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