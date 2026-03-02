import { useState } from "react";
import { useNavigate } from "react-router-dom";

// ─── API SERVICE LAYER ────────────────────────────────────────────────────────
const strategyService = {
  backtest: async (config) => {
    // TODO: replace with real API call
    // const res = await fetch("/api/strategy/backtest", {
    //   method: "POST", credentials: "include",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify(config),
    // });
    // if (!res.ok) throw new Error("Backtest failed");
    // return res.json(); // { cagr, sharpe, maxDrawdown, ... }
    await new Promise(r => setTimeout(r, 2200));
    return { success: true };
  },

  deploy: async (config) => {
    // TODO: replace with real API call
    // const res = await fetch("/api/strategy/deploy", {
    //   method: "POST", credentials: "include",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify(config),
    // });
    // if (!res.ok) throw new Error("Deploy failed");
    // return res.json();
    await new Promise(r => setTimeout(r, 1800));
    return { success: true };
  },
};
// ─────────────────────────────────────────────────────────────────────────────

const UNIVERSE_OPTIONS = [
  { value: "nifty50",  label: "Nifty 50",  desc: "Large cap · 50 stocks"  },
  { value: "nifty100", label: "Nifty 100", desc: "Large cap · 100 stocks" },
  { value: "nifty150", label: "Nifty 150", desc: "Large cap + Mid cap · 150 stocks"   },
  { value: "nifty250", label: "Nifty 250", desc: "Large cap + Mid cap · 250 stocks"   },
];

const LOOKBACK_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const REBALANCE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const DEFAULT_FORM = {
  universe:       "nifty50",
  numStocks:      10,
  lookback1:      6,
  lookback2:      12,
  priceCap:       "",
  capital:        "",
  rebalanceFreq:  1,
};

function validate(form) {
  const errors = {};
  if (!form.universe)                       errors.universe    = "Select a universe";
  if (!form.numStocks || form.numStocks < 1) errors.numStocks  = "Min 1 stock";
  if (form.lookback1 === form.lookback2)     errors.lookback2  = "Must differ from Period 1";
  if (!form.capital || Number(form.capital) < 10000) errors.capital = "Min ₹1,0000";
  return errors;
}

// ─── Field Components ─────────────────────────────────────────────────────────

function FieldLabel({ label, hint }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <span style={{
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 10, letterSpacing: "0.14em",
        textTransform: "uppercase", color: "rgba(255,255,255,0.35)",
      }}>{label}</span>
      {hint && (
        <span style={{
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 10, color: "rgba(255,255,255,0.2)",
          marginLeft: 8,
        }}>— {hint}</span>
      )}
    </div>
  );
}

function FieldError({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      fontFamily: "'JetBrains Mono',monospace",
      fontSize: 10, color: "#ff4d6d",
      marginTop: 6, letterSpacing: "0.04em",
    }}>⚠ {msg}</div>
  );
}

function StyledInput({ value, onChange, type = "number", placeholder, prefix, suffix, error }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{
      display: "flex", alignItems: "center",
      background: "rgba(255,255,255,0.03)",
      border: `1px solid ${error ? "rgba(255,77,109,0.4)" : focused ? "rgba(0,229,160,0.35)" : "rgba(255,255,255,0.08)"}`,
      borderRadius: 8,
      boxShadow: focused ? "0 0 0 3px rgba(0,229,160,0.07)" : "none",
      transition: "all 0.18s",
    }}>
      {prefix && (
        <span style={{
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 13, color: "rgba(255,255,255,0.3)",
          padding: "0 0 0 14px",
        }}>{prefix}</span>
      )}
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        min="1"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1, border: "none", outline: "none",
          background: "transparent",
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 14, color: "#fff",
          padding: prefix ? "12px 14px 12px 8px" : "12px 14px",
          letterSpacing: "0.03em",
        }}
      />
      {suffix && (
        <span style={{
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 11, color: "rgba(255,255,255,0.25)",
          padding: "0 14px 0 0",
        }}>{suffix}</span>
      )}
    </div>
  );
}

function SelectInput({ value, onChange, options, error }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      border: `1px solid ${error ? "rgba(255,77,109,0.4)" : focused ? "rgba(0,229,160,0.35)" : "rgba(255,255,255,0.08)"}`,
      borderRadius: 8, position: "relative",
      boxShadow: focused ? "0 0 0 3px rgba(0,229,160,0.07)" : "none",
      transition: "all 0.18s",
    }}>
      <select
        value={value}
        onChange={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: "100%", border: "none", outline: "none",
          background: "transparent",
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 13, color: "#fff",
          padding: "12px 36px 12px 14px",
          appearance: "none", cursor: "pointer",
          letterSpacing: "0.03em",
        }}
      >
        {options.map(o => (
          <option key={o.value ?? o} value={o.value ?? o}
            style={{ background: "#0d1526", color: "#fff" }}>
            {o.label ?? `${o} month${o > 1 ? "s" : ""}`}
          </option>
        ))}
      </select>
      <span style={{
        position: "absolute", right: 12, top: "50%",
        transform: "translateY(-50%)",
        color: "rgba(255,255,255,0.3)", fontSize: 10, pointerEvents: "none",
      }}>▼</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function DeployStrategy() {
  const navigate = useNavigate();
  const [form, setForm]         = useState(DEFAULT_FORM);
  const [errors, setErrors]     = useState({});
  const [btLoading, setBtLoading]  = useState(false);
  const [depLoading, setDepLoading] = useState(false);
  const [mounted, setMounted]   = useState(false);

  // mount animation
  useState(() => { setTimeout(() => setMounted(true), 40); });

  const set = (key) => (e) => {
    const val = e.target.type === "number" ? Number(e.target.value) : e.target.value;
    setForm(f => ({ ...f, [key]: val }));
    setErrors(er => ({ ...er, [key]: undefined }));
  };

  const handleBacktest = async () => {
    const errs = validate(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setBtLoading(true);
    try {
      await strategyService.backtest(form);
      navigate("/backtest-result", { state: { config: form } });
    } catch (e) {
      console.error(e);
    } finally {
      setBtLoading(false);
    }
  };

  const handleDeploy = async () => {
    const errs = validate(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setDepLoading(true);
    try {
      await strategyService.deploy(form);
      navigate("/dashboard");
    } catch (e) {
      console.error(e);
    } finally {
      setDepLoading(false);
    }
  };

  const anyLoading = btLoading || depLoading;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .dp-root {
          min-height: calc(100vh - 60px);
          background: #060a12;
          padding: 40px 40px 80px;
          font-family: 'Syne', sans-serif;
          position: relative;
        }
        .dp-root::before {
          content: '';
          position: fixed; inset: 0; pointer-events: none;
          background-image:
            linear-gradient(rgba(0,229,160,0.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,229,160,0.025) 1px, transparent 1px);
          background-size: 40px 40px;
        }

        .dp-wrap {
          max-width: 760px; margin: 0 auto;
          opacity: 0; transform: translateY(16px);
          transition: opacity 0.45s ease, transform 0.45s cubic-bezier(0.16,1,0.3,1);
        }
        .dp-wrap.mounted { opacity: 1; transform: translateY(0); }

        /* Header */
        .dp-page-sub {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; letter-spacing: 0.2em;
          color: rgba(0,229,160,0.55); text-transform: uppercase;
          margin-bottom: 6px;
        }
        .dp-page-title {
          font-size: 28px; font-weight: 800;
          color: #fff; letter-spacing: 0.01em;
          margin-bottom: 6px;
        }
        .dp-page-desc {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px; color: rgba(255,255,255,0.28);
          letter-spacing: 0.04em; margin-bottom: 36px;
          line-height: 1.6;
        }

        /* Card */
        .dp-card {
          background: rgba(10,16,30,0.88);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 14px; overflow: hidden;
          margin-bottom: 16px;
          position: relative;
        }
        .dp-card::before {
          content: '';
          position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, rgba(0,229,160,0.2), transparent);
        }
        .dp-card-header {
          padding: 16px 24px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          display: flex; align-items: center; gap: 10px;
        }
        .dp-card-num {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; color: #00e5a0;
          background: rgba(0,229,160,0.1);
          padding: 2px 8px; border-radius: 4px;
          letter-spacing: 0.08em;
        }
        .dp-card-title {
          font-size: 13px; font-weight: 700;
          letter-spacing: 0.06em; text-transform: uppercase;
          color: rgba(255,255,255,0.6);
        }
        .dp-card-body { padding: 22px 24px; }

        /* Universe grid */
        .dp-universe-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
        }
        @media (max-width: 600px) {
          .dp-universe-grid { grid-template-columns: repeat(2, 1fr); }
          .dp-root { padding: 24px 20px 80px; }
        }

        .dp-universe-opt {
          padding: 14px 12px;
          border-radius: 10px; cursor: pointer;
          border: 1px solid rgba(255,255,255,0.07);
          background: rgba(255,255,255,0.02);
          text-align: center; transition: all 0.18s;
          user-select: none;
        }
        .dp-universe-opt:hover {
          border-color: rgba(0,229,160,0.2);
          background: rgba(0,229,160,0.03);
        }
        .dp-universe-opt.selected {
          border-color: rgba(0,229,160,0.45);
          background: rgba(0,229,160,0.07);
          box-shadow: 0 0 0 2px rgba(0,229,160,0.08);
        }
        .dp-universe-label {
          font-family: 'Syne', sans-serif;
          font-size: 14px; font-weight: 700;
          color: #fff; margin-bottom: 4px;
        }
        .dp-universe-opt.selected .dp-universe-label { color: #00e5a0; }
        .dp-universe-desc {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; color: rgba(255,255,255,0.25);
          letter-spacing: 0.03em;
        }

        /* Two-col grid */
        .dp-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        @media (max-width: 520px) { .dp-grid-2 { grid-template-columns: 1fr; } }

        /* Action buttons */
        .dp-actions {
          display: flex; gap: 12px; margin-top: 28px; flex-wrap: wrap;
        }
        .dp-btn {
          flex: 1; min-width: 160px;
          font-family: 'Syne', sans-serif;
          font-size: 13px; font-weight: 700;
          letter-spacing: 0.08em; text-transform: uppercase;
          padding: 14px 20px; border-radius: 10px;
          border: none; cursor: pointer;
          display: flex; align-items: center; justify-content: center; gap: 8px;
          transition: all 0.18s;
        }
        .dp-btn:disabled { opacity: 0.55; cursor: not-allowed; }

        .dp-btn-ghost {
          background: rgba(255,255,255,0.04);
          color: rgba(255,255,255,0.65);
          border: 1px solid rgba(255,255,255,0.1);
        }
        .dp-btn-ghost:hover:not(:disabled) {
          background: rgba(255,255,255,0.08);
          color: #fff;
        }
        .dp-btn-primary {
          background: linear-gradient(135deg, #00e5a0, #00c98c);
          color: #060a12;
          box-shadow: 0 4px 20px rgba(0,229,160,0.22);
        }
        .dp-btn-primary:hover:not(:disabled) {
          opacity: 0.88; transform: translateY(-1px);
          box-shadow: 0 8px 28px rgba(0,229,160,0.3);
        }
        .dp-btn-primary:active:not(:disabled) { transform: translateY(0); }

        /* Loader dots */
        .dp-dots { display: flex; gap: 4px; align-items: center; }
        .dp-dots span {
          width: 5px; height: 5px; border-radius: 50%;
          background: currentColor;
          animation: dpDot 0.9s ease-in-out infinite;
        }
        .dp-dots span:nth-child(2) { animation-delay: 0.15s; }
        .dp-dots span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes dpDot {
          0%,80%,100%{transform:scale(1);opacity:0.5}
          40%{transform:scale(1.4);opacity:1}
        }

        /* Info strip */
        .dp-info-strip {
          display: flex; align-items: flex-start; gap: 10px;
          background: rgba(0,229,160,0.05);
          border: 1px solid rgba(0,229,160,0.12);
          border-radius: 8px; padding: 12px 14px;
          margin-top: 20px;
        }
        .dp-info-icon {
          font-size: 13px; color: rgba(0,229,160,0.6);
          flex-shrink: 0; margin-top: 1px;
        }
        .dp-info-text {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px; color: rgba(255,255,255,0.32);
          line-height: 1.65; letter-spacing: 0.03em;
        }
        .dp-info-text strong { color: rgba(255,255,255,0.55); font-weight: 500; }
      `}</style>

      <div className="dp-root">
        <div className={`dp-wrap ${mounted ? "mounted" : ""}`}>

          {/* ── Page Header ───────────────────────────────────────── */}
          <div className="dp-page-sub">// Strategy Configuration</div>
          <div className="dp-page-title">Deploy Strategy</div>
          <div className="dp-page-desc">
            Configure your momentum strategy parameters before backtesting or going live.
          </div>

          {/* ── 01 Universe ───────────────────────────────────────── */}
          <div className="dp-card">
            <div className="dp-card-header">
              <span className="dp-card-num">01</span>
              <span className="dp-card-title">Stock Universe</span>
            </div>
            <div className="dp-card-body">
              <FieldLabel label="Universe" hint="pool of stocks the strategy selects from" />
              <div className="dp-universe-grid">
                {UNIVERSE_OPTIONS.map(opt => (
                  <div
                    key={opt.value}
                    className={`dp-universe-opt ${form.universe === opt.value ? "selected" : ""}`}
                    onClick={() => { setForm(f => ({ ...f, universe: opt.value })); setErrors(e => ({ ...e, universe: undefined })); }}
                  >
                    <div className="dp-universe-label">{opt.label}</div>
                    <div className="dp-universe-desc">{opt.desc}</div>
                  </div>
                ))}
              </div>
              <FieldError msg={errors.universe} />
            </div>
          </div>

          {/* ── 02 Portfolio ──────────────────────────────────────── */}
          <div className="dp-card">
            <div className="dp-card-header">
              <span className="dp-card-num">02</span>
              <span className="dp-card-title">Portfolio Parameters</span>
            </div>
            <div className="dp-card-body">
              <div className="dp-grid-2">
                <div>
                  <FieldLabel label="No. of Stocks" hint="stocks held at any time" />
                  <StyledInput
                    value={form.numStocks}
                    onChange={set("numStocks")}
                    placeholder="e.g. 10"
                    suffix="stocks"
                    error={errors.numStocks}
                  />
                  <FieldError msg={errors.numStocks} />
                </div>
                <div>
                  <FieldLabel label="Stock Price Cap" hint="optional max price filter" />
                  <StyledInput
                    value={form.priceCap}
                    onChange={set("priceCap")}
                    placeholder="No limit"
                    prefix="₹"
                    error={errors.priceCap}
                  />
                  <FieldError msg={errors.priceCap} />
                </div>
              </div>
            </div>
          </div>

          {/* ── 03 Lookback Periods ───────────────────────────────── */}
          <div className="dp-card">
            <div className="dp-card-header">
              <span className="dp-card-num">03</span>
              <span className="dp-card-title">Lookback Periods</span>
            </div>
            <div className="dp-card-body">
              <div className="dp-grid-2">
                <div>
                  <FieldLabel label="Period 1" hint="primary return window" />
                  <SelectInput
                    value={form.lookback1}
                    onChange={set("lookback1")}
                    options={LOOKBACK_OPTIONS}
                    error={errors.lookback1}
                  />
                  <FieldError msg={errors.lookback1} />
                </div>
                <div>
                  <FieldLabel label="Period 2" hint="secondary return window" />
                  <SelectInput
                    value={form.lookback2}
                    onChange={set("lookback2")}
                    options={LOOKBACK_OPTIONS}
                    error={errors.lookback2}
                  />
                  <FieldError msg={errors.lookback2} />
                </div>
              </div>

              <div className="dp-info-strip" style={{ marginTop: 16 }}>
                <span className="dp-info-icon">ℹ</span>
                <div className="dp-info-text">
                  Stocks are scored using returns over <strong>Period 1</strong> and <strong>Period 2</strong>. Using two different windows (e.g. <strong>6M + 12M</strong>) reduces signal noise and improves rank stability.
                </div>
              </div>
            </div>
          </div>

          {/* ── 04 Capital & Rebalance ────────────────────────────── */}
          <div className="dp-card">
            <div className="dp-card-header">
              <span className="dp-card-num">04</span>
              <span className="dp-card-title">Capital & Rebalancing</span>
            </div>
            <div className="dp-card-body">
              <div className="dp-grid-2">
                <div>
                  <FieldLabel label="Capital" hint="total amount to deploy" />
                  <StyledInput
                    value={form.capital}
                    onChange={set("capital")}
                    placeholder="e.g. 500000"
                    prefix="₹"
                    error={errors.capital}
                  />
                  <FieldError msg={errors.capital} />
                </div>
                <div>
                  <FieldLabel label="Rebalance Frequency" hint="how often to re-rank" />
                  <SelectInput
                    value={form.rebalanceFreq}
                    onChange={set("rebalanceFreq")}
                    options={REBALANCE_OPTIONS}
                    error={errors.rebalanceFreq}
                  />
                  <FieldError msg={errors.rebalanceFreq} />
                </div>
              </div>

              <div className="dp-info-strip" style={{ marginTop: 16 }}>
                <span className="dp-info-icon">ℹ</span>
                <div className="dp-info-text">
                  Every <strong>{form.rebalanceFreq} month{form.rebalanceFreq > 1 ? "s" : ""}</strong>, the engine re-ranks stocks in the universe and rebalances the portfolio. Lower frequency = fewer transactions and lower costs.
                </div>
              </div>
            </div>
          </div>

          {/* ── Config Summary Strip ──────────────────────────────── */}
          {form.capital && form.numStocks && (
            <div style={{
              background: "rgba(0,229,160,0.04)",
              border: "1px solid rgba(0,229,160,0.1)",
              borderRadius: 10, padding: "14px 20px",
              display: "flex", gap: 24, flexWrap: "wrap",
            }}>
              {[
                ["Universe",    UNIVERSE_OPTIONS.find(o => o.value === form.universe)?.label],
                ["Stocks",      form.numStocks],
                ["Lookback",    `${form.lookback1}M + ${form.lookback2}M`],
                ["Capital",     form.capital ? `₹${Number(form.capital).toLocaleString("en-IN")}` : "—"],
                ["Rebalance",   `Every ${form.rebalanceFreq}M`],
                ["Price Cap",   form.priceCap ? `₹${Number(form.priceCap).toLocaleString("en-IN")}` : "None"],
              ].map(([k, v]) => (
                <div key={k}>
                  <div style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase",
                    color: "rgba(255,255,255,0.25)", marginBottom: 3,
                  }}>{k}</div>
                  <div style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 13, color: "#00e5a0", fontWeight: 500,
                  }}>{v}</div>
                </div>
              ))}
            </div>
          )}

          {/* ── Action Buttons ────────────────────────────────────── */}
          <div className="dp-actions">
            <button
              className="dp-btn dp-btn-ghost"
              onClick={handleBacktest}
              disabled={anyLoading}
            >
              {btLoading ? (
                <><span>Running</span><div className="dp-dots"><span/><span/><span/></div></>
              ) : (
                <><span>⟳</span> Backtest</>
              )}
            </button>
            <button
              className="dp-btn dp-btn-primary"
              onClick={handleDeploy}
              disabled={anyLoading}
            >
              {depLoading ? (
                <><span>Deploying</span><div className="dp-dots"><span/><span/><span/></div></>
              ) : (
                <><span>▶</span> Deploy Live</>
              )}
            </button>
          </div>

        </div>
      </div>
    </>
  );
}