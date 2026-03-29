import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { SYS, MONO } from "./constants.js";
import { api } from "./api.js";
import { fmtCompact, fmt } from "./formatters.js";
import { useLiveWebSocket } from "./useLiveWebSocket.js";

import { WsStatusPill, StatusBadge } from "./components/StatusBadges.jsx";
import { ConfirmModal } from "./components/ConfirmModal.jsx";
import { Spinner, ErrorBanner } from "./components/Feedback.jsx";
import { NoStrategy } from "./components/NoStrategy.jsx";
import { StatCard, PriceSourceBadge } from "./components/StatCard.jsx";
import { PortfolioChartPanel } from "./components/PortfolioChart.jsx";
import { HoldingsPanel, PositionsPanel  } from "./components/HoldingsPanel.jsx";
import { StrategyPanel } from "./components/StrategyPanel.jsx";
import { DayZeroBanner, DeploymentSnapshot } from "./components/DeploymentSnapshot.jsx";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MAX_AUTO_RETRIES = 2;
const RETRY_DELAY_MS   = 1000;
 
// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate();
 
  const [portfolio,     setPortfolio]     = useState(null);
  const [chartData,     setChartData]     = useState([]);
  const [view,          setView]          = useState(null);
  const [range,         setRange]         = useState("1M");
  const [loading,       setLoading]       = useState(true);
  const [chartLoading,  setChartLoading]  = useState(false);
  const [mounted,       setMounted]       = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [error,         setError]         = useState(null);
 
  const [offline,       setOffline]       = useState(false);
  const [retrying,      setRetrying]      = useState(false);
  const [retryAttempt,  setRetryAttempt]  = useState(0);
  const retryTimer = useRef(null);
 
  const [flashValue, setFlashValue] = useState(false);
 
  // ─── Fetch portfolio ───────────────────────────────────────────────────────
  const fetchPortfolio = useCallback(async () => {
    try {
      const data = await api.getPortfolio();
      setPortfolio(data);
      setOffline(false);
      setRetrying(false);
      setRetryAttempt(0);
      setLoading(false);
      setTimeout(() => setMounted(true), 40);
    } catch (err) {
      if (err.message === "UNAUTHORIZED") {
        navigate("/login");
        return;
      }
      setLoading(false);
      setOffline(true);
      setRetrying(false);
    }
  }, [navigate]);
 
  const scheduleAutoRetry = useCallback((attempt) => {
    if (attempt >= MAX_AUTO_RETRIES) {
      navigate("/offline");
      return;
    }
    retryTimer.current = setTimeout(async () => {
      const next = attempt + 1;
      setRetryAttempt(next);
      setRetrying(true);
      try {
        const data = await api.getPortfolio();
        setPortfolio(data);
        setOffline(false);
        setRetrying(false);
        setRetryAttempt(0);
        setLoading(false);
        setTimeout(() => setMounted(true), 40);
      } catch (err) {
        if (err.message === "UNAUTHORIZED") { navigate("/login"); return; }
        setRetrying(false);
        scheduleAutoRetry(next);
      }
    }, RETRY_DELAY_MS);
  }, [navigate]);
 
  useEffect(() => {
    fetchPortfolio().then(() => {}).catch(() => {});
    return () => clearTimeout(retryTimer.current);
  }, []);
 
  useEffect(() => {
    if (!offline) return;
    scheduleAutoRetry(retryAttempt);
    return () => clearTimeout(retryTimer.current);
  }, [offline]);
 
  const handleManualRetry = useCallback(() => {
    clearTimeout(retryTimer.current);
    setRetryAttempt(0);
    setRetrying(true);
    fetchPortfolio();
  }, [fetchPortfolio]);
 
  // ─── Chart data ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (view !== "chart") return;
    setChartLoading(true);
    api.getChartData(range)
      .then(data => {
        const cleanData = (data ?? [])
          .filter(d => {
            const val = Number(d.value);
            return Number.isFinite(val) && val > 0 && d.date;
          })
          .sort((a, b) => new Date(a.date) - new Date(b.date));
        setChartData(cleanData);
        setChartLoading(false);
      })
      .catch(err => {
        setChartLoading(false);
        if (err.message === "UNAUTHORIZED") navigate("/login");
        else setError(err.message || "Failed to load chart.");
      });
  }, [view, range, navigate]);
 
  // ─── WebSocket: holdings delta update ─────────────────────────────────────
  const handleHoldingsUpdate = useCallback((items) => {
    setPortfolio(prev => {
      if (!prev?.holdings) return prev;
      const updatedHoldings = prev.holdings.map(h => {
        const update = items.find(i => i.symbol === h.symbol);
        if (!update) return h;
 
        const ltp = Number(update.ltp);
        if (!Number.isFinite(ltp) || ltp <= 0) {
          console.warn(`Invalid LTP for ${h.symbol}:`, update.ltp);
          return h;
        }
        const avgPrice = Number(h.avgPrice);
        if (!Number.isFinite(avgPrice) || avgPrice <= 0) {
          console.warn(`Invalid avgPrice for ${h.symbol}:`, h.avgPrice);
          return h;
        }
        const qty = Number(h.qty);
        if (!Number.isFinite(qty) || qty <= 0) {
          console.warn(`Invalid qty for ${h.symbol}:`, h.qty);
          return h;
        }
 
        const value  = ltp * qty;
        const pnl    = value - avgPrice * qty;
        const pnlPct = ((ltp - avgPrice) / avgPrice) * 100;
 
        return { ...h, ltp, value, pnl, pnlPct, priceSource: "live", priceTs: update.ts };
      });
      return { ...prev, holdings: updatedHoldings };
    });
  }, []);
 
  // ─── WebSocket: positions delta update ────────────────────────────────────
  // Same pattern as holdings — backend sends only ltp + ts as deltas.
  // Recalculates value/pnl/pnlPct from existing avgPrice + qty in REST data.
  const handlePositionsUpdate = useCallback((items) => {
    setPortfolio(prev => {
      if (!prev?.positions) return prev;
      const updatedPositions = prev.positions.map(p => {
        const update = items.find(i => i.symbol === p.symbol);
        if (!update) return p;
 
        const ltp = Number(update.ltp);
        if (!Number.isFinite(ltp) || ltp <= 0) {
          console.warn(`Invalid LTP for position ${p.symbol}:`, update.ltp);
          return p;
        }
        const avgPrice = Number(p.avgPrice);
        if (!Number.isFinite(avgPrice) || avgPrice <= 0) {
          console.warn(`Invalid avgPrice for position ${p.symbol}:`, p.avgPrice);
          return p;
        }
        const qty = Number(p.qty);
        if (!Number.isFinite(qty) || qty <= 0) {
          console.warn(`Invalid qty for position ${p.symbol}:`, p.qty);
          return p;
        }
 
        const value  = ltp * qty;
        const pnl    = value - avgPrice * qty;
        const pnlPct = ((ltp - avgPrice) / avgPrice) * 100;
 
        return { ...p, ltp, value, pnl, pnlPct, priceSource: "live", priceTs: update.ts };
      });
      return { ...prev, positions: updatedPositions };
    });
  }, []);
 
  // ─── WebSocket: summary update ─────────────────────────────────────────────
  const handleSummaryUpdate = useCallback((summary) => {
    setPortfolio(prev => {
      if (!prev?.summary) return prev;
 
      const newCurrentValue = Number(summary.currentValue);
      const newCash         = Number(summary.cash);
      const newPnl          = Number(summary.pnl);
      const newPnlPct       = Number(summary.pnlPct);
      const newInvested     = Number(summary.invested);
 
      if (!Number.isFinite(newCurrentValue)) { console.warn("Invalid currentValue:", summary.currentValue); return prev; }
      if (!Number.isFinite(newCash))         { console.warn("Invalid cash:", summary.cash);                 return prev; }
      if (!Number.isFinite(newPnl))          { console.warn("Invalid pnl:", summary.pnl);                  return prev; }
      if (!Number.isFinite(newPnlPct))       { console.warn("Invalid pnlPct:", summary.pnlPct);            return prev; }
      if (!Number.isFinite(newInvested))     { console.warn("Invalid invested:", summary.invested);        return prev; }
 
      return {
        ...prev,
        summary: {
          ...prev.summary,
          invested:     newInvested,
          currentValue: newCurrentValue,
          cash:         newCash,
          pnl:          newPnl,
          pnlPct:       newPnlPct,
          priceSource:  "live",
        },
      };
    });
    setFlashValue(true);
    setTimeout(() => setFlashValue(false), 700);
  }, []);
 
  const handleUnauthorized = useCallback(() => {
    navigate("/login");
  }, [navigate]);
 
  // ─── WebSocket enable condition ────────────────────────────────────────────
  const wsEnabled = !!(
    portfolio?.strategyDeployed &&
    portfolio?.strategy &&
    portfolio?.strategy?.status === "active"
  );
 
  const wsStatus = useLiveWebSocket({
    enabled:            wsEnabled,
    onHoldingsUpdate:   handleHoldingsUpdate,
    onPositionsUpdate:  handlePositionsUpdate,   // ← NEW
    onSummaryUpdate:    handleSummaryUpdate,
    onUnauthorized:     handleUnauthorized,
  });
 
  // ─── View toggle (chart / holdings / positions — mutually exclusive) ───────
  const handleViewToggle = v => setView(prev => prev === v ? null : v);
 
  // ─── Strategy actions ──────────────────────────────────────────────────────
  async function handleConfirm() {
    const action = confirmAction;
    setConfirmAction(null);
    setActionLoading(true);
    setError(null);
 
    try {
      await api.postAction(action);
      const fresh = await api.getPortfolio();
      setPortfolio(fresh);
      setView(null);
 
      if (action === "stop" && fresh?.strategyDeployed) {
        setError("Stop request sent, but strategy is still deployed on server. Please check backend stop logic.");
      }
    } catch (err) {
      if (err.message === "UNAUTHORIZED") navigate("/login");
      else setError("Action failed. Please try again.");
    } finally {
      setActionLoading(false);
    }
  }
 
  // ─── Loading state ─────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{
      minHeight: "calc(100vh - 56px)", background: "#f2f2f2",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <Spinner size={34} />
    </div>
  );
 
  // ─── Offline state ─────────────────────────────────────────────────────────
  if (!portfolio) {
    if (offline) {
      return (
        <div style={{
          minHeight: "calc(100vh - 56px)", background: "#f2f2f2",
          display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 20,
        }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#333", marginBottom: 8 }}>
              Connection Lost
            </div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 20 }}>
              Unable to load portfolio. Retrying automatically...
            </div>
            <button
              onClick={handleManualRetry}
              style={{
                padding: "10px 24px", borderRadius: 6, border: "none",
                background: "#222", color: "#fff",
                fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: SYS,
              }}
            >
              Retry Now
            </button>
          </div>
        </div>
      );
    }
  }
 
  const { user, summary, holdings, positions, strategyDeployed, strategy } = portfolio;
  const pnlPos = (summary?.pnl ?? 0) >= 0;
 
  const initialCapital          = Number(strategy?.capital ?? 0);
  const currentValueForSnapshot = Number(summary?.currentValue ?? 0);
 
  // Day-zero: strategy deployed but no trades yet
  const isDayZero = strategyDeployed && (holdings?.length === 0) && (summary?.invested === 0);
 
  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
 
        .db-root { padding: 28px 28px 72px; font-family: ${SYS}; }
        .db-wrap {
          max-width: 1100px; margin: 0 auto;
          opacity: 0; transform: translateY(10px);
          transition: opacity 0.35s ease, transform 0.35s ease;
        }
        .db-wrap.mounted { opacity: 1; transform: translateY(0); }
 
        .db-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
        @media (max-width: 860px) { .db-summary { grid-template-columns: repeat(2, 1fr); } .db-root { padding: 18px 14px 60px; } }
        @media (max-width: 480px) { .db-summary { grid-template-columns: 1fr; } }
 
        .db-deploy-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
        @media (max-width: 860px) { .db-deploy-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (max-width: 560px) { .db-deploy-grid { grid-template-columns: 1fr; } }
 
        @keyframes statIn  { to { opacity: 1; transform: translateY(0); } }
        @keyframes panelIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes dbSpin  { to { transform: rotate(360deg); } }
        @keyframes pulse   { 0%,100% { box-shadow: 0 0 0 2px #bbf7d0; } 50% { box-shadow: 0 0 0 4px #dcfce7; } }
        @keyframes ltpFlash { 0% { background: #f0fdf4; } 100% { background: transparent; } }
 
        .db-toggles { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
        .db-toggle {
          font-size: 12px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
          padding: 8px 18px; border-radius: 6px; border: none; cursor: pointer;
          display: flex; align-items: center; gap: 7px; transition: all 0.14s; font-family: ${SYS};
        }
        .db-toggle-off { background: #fff; color: #555; border: 1px solid #ccc; }
        .db-toggle-off:hover { background: #f5f5f5; border-color: #999; }
        .db-toggle-on  { background: #222; color: #fff; }
 
        .db-panel { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; animation: panelIn 0.3s ease both; }
        .db-panel-header {
          padding: 13px 20px; border-bottom: 1px solid #ebebeb; background: #f8f8f8;
          display: flex; align-items: center; justify-content: space-between;
        }
        .db-panel-title { font-size: 12px; font-weight: 700; color: #333; text-transform: uppercase; letter-spacing: 0.05em; }
 
        .db-ranges { display: flex; gap: 3px; }
        .db-range { font-family: ${MONO}; font-size: 11px; padding: 4px 10px; border-radius: 5px; border: none; cursor: pointer; transition: all 0.13s; }
        .db-range-on  { background: #222; color: #fff; }
        .db-range-off { background: transparent; color: #888; }
        .db-range-off:hover { background: #f0f0f0; color: #333; }
 
        .db-table { width: 100%; border-collapse: collapse; }
        .db-table thead th {
          font-family: ${MONO}; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
          color: #888; padding: 11px 18px; font-weight: 600; text-align: right;
          border-bottom: 1px solid #ebebeb; background: #f8f8f8;
        }
        .db-table thead th:first-child { text-align: left; }
        .db-table tbody tr { border-bottom: 1px solid #f0f0f0; transition: background 0.13s; }
        .db-table tbody tr:last-child { border-bottom: none; }
        .db-table tbody tr:hover { background: #fafafa; }
        .db-table td { padding: 11px 18px; font-family: ${MONO}; font-size: 13px; color: #333; text-align: right; vertical-align: middle; }
        .db-table td:first-child { text-align: left; }
        .db-sym      { font-weight: 700; color: #111; font-size: 13px; }
        .db-sym-name { font-size: 10px; color: #999; margin-top: 2px; }
        .db-pnl-pct  { font-size: 10px; margin-top: 2px; }
        .pos-text { color: #1b6f3e; }
        .neg-text { color: #c62828; }
        .ltp-flash { animation: ltpFlash 0.7s ease; }
      `}</style>
 
      {confirmAction && (
        <ConfirmModal action={confirmAction} onConfirm={handleConfirm} onCancel={() => setConfirmAction(null)} />
      )}
 
      {actionLoading && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 999,
          background: "rgba(255,255,255,0.6)", backdropFilter: "blur(2px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Spinner size={36} />
        </div>
      )}
 
      <div className="db-root">
        <div className={`db-wrap ${mounted ? "mounted" : ""}`}>
 
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
 
          {/* ── Header ── */}
          <div style={{
            marginBottom: 22,
            display: "flex", alignItems: "flex-start",
            justifyContent: "space-between", flexWrap: "wrap", gap: 10,
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>
                Welcome back
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#111" }}>
                {user.name}
              </div>
            </div>
            {strategyDeployed && strategy && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#999", fontFamily: SYS }}>Strategy</span>
                <StatusBadge status={strategy.status} />
                <WsStatusPill status={wsStatus} />
              </div>
            )}
          </div>
 
          {/* ── No strategy ── */}
          {!strategyDeployed ? (
            <NoStrategy onDeploy={() => navigate("/deploy")} />
          ) : (
            <>
              {strategy && (
                <StrategyPanel strategy={strategy} onAction={setConfirmAction} />
              )}
 
              {strategy && (
                <DeploymentSnapshot
                  initialCapital={initialCapital}
                  currentValue={currentValueForSnapshot}
                />
              )}
 
              {/* Day-zero banner */}
              {isDayZero && (
                <DayZeroBanner nextRebalance={strategy?.nextRebalance} />
              )}
 
              {/* Summary stat cards — hidden on day-zero */}
              {summary && !isDayZero && (
                <div className="db-summary">
                  <StatCard
                    label="Invested"
                    value={fmtCompact(summary.invested)}
                    sub={fmt(summary.invested)}
                    delay="0.04s"
                  />
                  <StatCard
                    label="Equity Value"
                    value={fmtCompact(summary.equity)}
                    sub={
                      <>
                        {fmt(summary.equity)}
                        <PriceSourceBadge source={summary.priceSource} />
                      </>
                    }
                    delay="0.09s"
                    flash={flashValue}
                  />
                  <StatCard
                    label="P&L"
                    value={(pnlPos ? "+" : "") + fmtCompact(summary.pnl)}
                    sub={(pnlPos ? "▲ " : "▼ ") + Math.abs(summary.pnlPct).toFixed(2) + "%"}
                    pnlType={pnlPos ? "pos" : "neg"}
                    delay="0.14s"
                    flash={flashValue}
                  />
                  <StatCard
                    label="Cash Available"
                    value={fmtCompact(summary.cash)}
                    sub={fmt(summary.cash)}
                    delay="0.19s"
                  />
                </div>
              )}
 
              {/* ── Toggle buttons ── */}
              <div className="db-toggles">
                {/* Chart toggle hidden on day-zero */}
                {!isDayZero && (
                  <button
                    className={`db-toggle ${view === "chart" ? "db-toggle-on" : "db-toggle-off"}`}
                    onClick={() => handleViewToggle("chart")}
                  >
                    <span>▲</span> Portfolio Chart
                  </button>
                )}
                <button
                  className={`db-toggle ${view === "holdings" ? "db-toggle-on" : "db-toggle-off"}`}
                  onClick={() => handleViewToggle("holdings")}
                >
                  <span>≡</span> Holdings
                </button>
                {/* Positions button — always shown when strategy is deployed */}
                <button
                  className={`db-toggle ${view === "positions" ? "db-toggle-on" : "db-toggle-off"}`}
                  onClick={() => handleViewToggle("positions")}
                >
                  <span>⇄</span> Positions
                </button>
              </div>
 
              {/* ── Chart panel ── */}
              {view === "chart" && !isDayZero && (
                <PortfolioChartPanel
                  chartData={chartData}
                  chartLoading={chartLoading}
                  range={range}
                  onRangeChange={setRange}
                />
              )}
 
              {/* ── Holdings panel ── */}
              {view === "holdings" && (
                <HoldingsPanel holdings={holdings} />
              )}
 
              {/* ── Positions panel ── */}
              {view === "positions" && (
                <PositionsPanel positions={positions ?? []} />
              )}
            </>
          )}
 
        </div>
      </div>
    </>
  );
}