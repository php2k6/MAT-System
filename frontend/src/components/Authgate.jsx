import { useNavigate } from "react-router-dom";

const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

const STATES = {
  loading: {
    icon: null,
    label: "Initializing",
    title: "Loading Terminal",
    description: "Checking your session and broker connection...",
    action: null,
  },
  unauthenticated: {
    icon: "⬡",
    label: "Not Authenticated",
    title: "Access Restricted",
    description: "You need to sign in to access the trading dashboard.",
    action: { label: "Sign In", to: "/login" },
  },
  "no-broker": {
    icon: "⬡",
    label: "Broker Offline",
    title: "No Broker Connected",
    description: "Connect your broker to start using the MAT trading engine.",
    action: { label: "Connect Broker", to: null },
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
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .ag-wrap {
          min-height: calc(100vh - 56px);
          background: #f2f2f2;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: ${SYS};
          padding: 32px 20px;
        }

        .ag-box {
          background: #fff;
          border: 1px solid #e0e0e0;
          border-radius: 10px;
          padding: 36px 32px 32px;
          text-align: center;
          max-width: 400px;
          width: 100%;
        }

        .ag-icon-ring {
          width: 60px; height: 60px;
          border-radius: 50%;
          border: 1.5px solid #e0e0e0;
          background: #f5f5f5;
          display: flex; align-items: center; justify-content: center;
          margin: 0 auto 20px;
        }
        .ag-icon {
          font-size: 22px;
          color: #888;
        }

        .ag-spinner {
          width: 24px; height: 24px;
          border: 2.5px solid #e8e8e8;
          border-top-color: #333;
          border-radius: 50%;
          animation: agSpin 0.7s linear infinite;
        }
        @keyframes agSpin { to { transform: rotate(360deg); } }

        .ag-label {
          font-size: 10px; font-weight: 600;
          letter-spacing: 0.1em; text-transform: uppercase;
          color: #999; margin-bottom: 8px;
          font-family: ${SYS};
        }

        .ag-title {
          font-size: 22px; font-weight: 700;
          color: #111; margin-bottom: 8px;
          font-family: ${SYS};
        }

        .ag-divider {
          width: 36px; height: 1px;
          background: #e0e0e0;
          margin: 0 auto 16px;
        }

        .ag-desc {
          font-size: 13px; color: #555;
          line-height: 1.65; margin-bottom: 24px;
          font-family: ${SYS};
        }

        .ag-btn {
          font-family: ${SYS};
          font-size: 13px; font-weight: 700;
          letter-spacing: 0.03em; text-transform: uppercase;
          padding: 11px 28px; border-radius: 7px;
          border: none; cursor: pointer;
          background: #222; color: #fff;
          transition: background 0.14s;
        }
        .ag-btn:hover  { background: #3a3a3a; }
        .ag-btn:active { background: #111; }

        .ag-steps {
          margin-top: 24px;
          display: flex; flex-direction: column; gap: 8px;
          text-align: left;
        }
        .ag-step {
          display: flex; align-items: flex-start; gap: 10px;
          padding: 10px 13px;
          background: #fafafa;
          border: 1px solid #ebebeb;
          border-radius: 7px;
        }
        .ag-step-num {
          width: 20px; height: 20px; border-radius: 5px;
          background: #222; color: #fff;
          font-size: 10px; font-weight: 700; font-family: ${SYS};
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0; margin-top: 1px;
        }
        .ag-step-text {
          font-size: 12px; color: #555;
          line-height: 1.55; font-family: ${SYS};
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

          {/* Broker steps */}
          {state === "no-broker" && (
            <div className="ag-steps">
              {[
                ["1", `Click "Connect Broker" and provide your API credentials`],
                ["2", "MAT will verify the connection and sync your account"],
                ["3", "Momentum engine activates and dashboard goes live"],
              ].map(([num, text]) => (
                <div key={num} className="ag-step">
                  <span className="ag-step-num">{num}</span>
                  <span className="ag-step-text">{text}</span>
                </div>
              ))}
            </div>
          )}

        </div>
      </div>
    </>
  );
}