const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

export default function Offline() {
  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes offFadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

        .off-root {
          min-height: 100vh;
          background: #f4f4f4;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          font-family: ${SYS};
        }
        .off-card {
          background: #fff;
          border: 1px solid #e0e0e0;
          border-radius: 12px;
          padding: 44px 36px 36px;
          max-width: 420px;
          width: 100%;
          text-align: center;
          box-shadow: 0 4px 28px rgba(0,0,0,0.07);
          animation: offFadeIn 0.35s ease both;
        }
        .off-icon-ring {
          width: 64px; height: 64px;
          border-radius: 50%;
          background: #fef2f2;
          border: 1px solid #fecaca;
          display: flex; align-items: center; justify-content: center;
          font-size: 26px;
          margin: 0 auto 22px;
        }
        .off-title {
          font-size: 20px; font-weight: 700; color: #111; margin-bottom: 10px;
        }
        .off-desc {
          font-size: 13px; color: #666; line-height: 1.7;
          max-width: 320px; margin: 0 auto 24px;
        }
        .off-divider {
          width: 40px; height: 1px;
          background: #e5e7eb;
          margin: 0 auto 24px;
        }
        .off-status-row {
          display: inline-flex; align-items: center; gap: 7px;
          padding: 6px 14px; border-radius: 20px;
          background: #fef2f2; border: 1px solid #fecaca;
          font-size: 11px; font-weight: 600; color: #b91c1c;
          font-family: ${MONO}; margin-bottom: 28px;
          letter-spacing: 0.03em;
        }
        .off-status-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: #ef4444; flex-shrink: 0;
        }
        .off-hint {
          font-size: 12px; color: #999; line-height: 1.65;
          padding: 14px 16px;
          background: #f9f9f9; border: 1px solid #eeeeee;
          border-radius: 7px;
        }
        .off-hint strong { color: #555; font-weight: 600; }
      `}</style>

      <div className="off-root">
        <div className="off-card">

          <div className="off-icon-ring">⚡</div>

          <div className="off-title">Server Unavailable</div>
          <div className="off-desc">
            We can't reach the server right now. It may be under maintenance or experiencing a temporary outage.
          </div>

          <div className="off-divider" />

          <div className="off-status-row">
            <span className="off-status-dot" />
            Server not responding
          </div>

          <div className="off-hint">
            <strong>What you can do:</strong> Please wait a few minutes and refresh this page manually. If the problem persists, contact support.
          </div>

        </div>
      </div>
    </>
  );
}