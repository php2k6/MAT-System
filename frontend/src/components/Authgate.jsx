import { useNavigate } from "react-router-dom";


const STATES = {
  loading: {
    icon: null,
    label: "INITIALIZING",
    title: "Loading Terminal",
    description: "Checking your session and broker connection...",
    action: null,
  },
  unauthenticated: {
    icon: "⬡",
    label: "NOT AUTHENTICATED",
    title: "Access Restricted",
    description: "You need to sign in to access the trading dashboard.",
    action: { label: "Sign In", to: "/login", variant: "primary" },
  },
  "no-broker": {
    icon: "⬡",
    label: "BROKER OFFLINE",
    title: "No Broker Connected",
    description: "Connect your broker to start using the MAT trading engine.",
    action: { label: "Connect Broker", to: null, variant: "primary" },
  },
};

export default function AuthGate({ state = "unauthenticated", onConnectBroker }) {
  const navigate = useNavigate();
  const config = STATES[state];

  const handleAction = () => {
    if (!config.action) return;
    if (config.action.to) navigate(config.action.to);
    else if (state === "no-broker" && onConnectBroker) onConnectBroker();
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

        .ag-wrap {
          min-height: calc(100vh - 60px);
          background: #060a12;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Syne', sans-serif;
          position: relative;
          overflow: hidden;
        }

        /* Subtle grid */
        .ag-wrap::before {
          content: '';
          position: absolute; inset: 0;
          background-image:
            linear-gradient(rgba(0,229,160,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,229,160,0.03) 1px, transparent 1px);
          background-size: 40px 40px;
        }

        /* Center glow */
        .ag-wrap::after {
          content: '';
          position: absolute; inset: 0;
          background: radial-gradient(ellipse 50% 40% at 50% 50%, rgba(0,229,160,0.05) 0%, transparent 70%);
          pointer-events: none;
        }

        .ag-box {
          position: relative; z-index: 1;
          text-align: center;
          max-width: 380px;
          padding: 24px;
        }

        /* Icon ring */
        .ag-icon-ring {
          width: 72px; height: 72px;
          border-radius: 50%;
          border: 1px solid rgba(0,229,160,0.2);
          display: flex; align-items: center; justify-content: center;
          margin: 0 auto 24px;
          position: relative;
          background: rgba(0,229,160,0.04);
        }
        .ag-icon-ring::before {
          content: '';
          position: absolute; inset: -6px;
          border-radius: 50%;
          border: 1px solid rgba(0,229,160,0.08);
        }
        .ag-icon {
          font-size: 28px;
          color: rgba(0,229,160,0.5);
        }

        /* Loading spinner */
        .ag-spinner {
          width: 28px; height: 28px;
          border: 2px solid rgba(0,229,160,0.15);
          border-top-color: #00e5a0;
          border-radius: 50%;
          animation: agSpin 0.8s linear infinite;
        }
        @keyframes agSpin { to { transform: rotate(360deg); } }

        /* Label */
        .ag-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 0.18em;
          color: rgba(0,229,160,0.5);
          text-transform: uppercase;
          margin-bottom: 10px;
        }

        /* Title */
        .ag-title {
          font-size: 24px;
          font-weight: 700;
          color: #fff;
          letter-spacing: 0.01em;
          margin-bottom: 10px;
        }

        /* Description */
        .ag-desc {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          color: rgba(255,255,255,0.35);
          line-height: 1.7;
          letter-spacing: 0.03em;
          margin-bottom: 28px;
        }

        /* Divider */
        .ag-divider {
          width: 40px; height: 1px;
          background: rgba(0,229,160,0.2);
          margin: 0 auto 28px;
        }

        /* Action button */
        .ag-btn {
          font-family: 'Syne', sans-serif;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          padding: 11px 28px;
          border-radius: 8px;
          border: none;
          cursor: pointer;
          transition: opacity 0.15s, transform 0.15s;
          background: linear-gradient(135deg, #00e5a0, #00c98c);
          color: #060a12;
          box-shadow: 0 4px 20px rgba(0,229,160,0.2);
        }
        .ag-btn:hover { opacity: 0.88; transform: translateY(-1px); }
        .ag-btn:active { transform: translateY(0); }

        /* No-broker specific: show steps */
        .ag-steps {
          margin-top: 28px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          text-align: left;
        }
        .ag-step {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 12px 14px;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px;
        }
        .ag-step-num {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          color: #00e5a0;
          background: rgba(0,229,160,0.1);
          border-radius: 4px;
          padding: 2px 7px;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .ag-step-text {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: rgba(255,255,255,0.4);
          line-height: 1.5;
          letter-spacing: 0.03em;
        }
      `}</style>

      <div className="ag-wrap">
        <div className="ag-box">
          {/* Icon / Spinner */}
          <div className="ag-icon-ring">
            {state === "loading"
              ? <div className="ag-spinner" />
              : <span className="ag-icon">{config.icon}</span>
            }
          </div>

          {/* Label */}
          <div className="ag-label">{config.label}</div>

          {/* Title */}
          <div className="ag-title">{config.title}</div>

          <div className="ag-divider" />

          {/* Description */}
          <div className="ag-desc">{config.description}</div>

          {/* CTA */}
          {config.action && (
            <button className="ag-btn" onClick={handleAction}>
              {config.action.label}
            </button>
          )}

          {/* Extra: broker steps */}
          {state === "no-broker" && (
            <div className="ag-steps">
              <div className="ag-step">
                <span className="ag-step-num">01</span>
                <span className="ag-step-text">Click "Connect Broker" and provide your API credentials</span>
              </div>
              <div className="ag-step">
                <span className="ag-step-num">02</span>
                <span className="ag-step-text">MAT will verify the connection and sync your account</span>
              </div>
              <div className="ag-step">
                <span className="ag-step-num">03</span>
                <span className="ag-step-text">Momentum engine activates and dashboard goes live</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}