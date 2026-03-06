import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

const api = axios.create({
  baseURL: `${API_BASE_URL}`,
  withCredentials: true,
});

const authService = {
  getMe:           () => api.get("/auth/me"),
  logout:          () => api.post("/auth/logout"),
  getBrokerStatus: () => api.get("/broker/status"),
  connectBroker:   () => api.post("/broker/connect"),
};

const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

export default function Navbar() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [brokerConnected, setBrokerConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initialize = async () => {
      try {
        const [authRes, brokerRes] = await Promise.all([
          authService.getMe(),
          authService.getBrokerStatus(),
        ]);
        setUser(authRes.data.user);
        setBrokerConnected(brokerRes.data.brokerConnected);
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    };
    initialize();
  }, []);

  const handleLogout = async () => {
    try {
      await authService.logout();
      setUser(null);
      setBrokerConnected(false);
      navigate("/login");
    } catch {
      console.error("Logout failed");
    }
  };

  const handleConnectBroker = async () => {
    try {
      const res = await authService.connectBroker();
      if (res.data.success && res.data.redirectUrl) {
        window.location.href = res.data.redirectUrl;
      }
    } catch (err) {
      console.error("Broker connection failed", err);
    }
  };

  const isOnline = user && brokerConnected;
  const statusLabel = isOnline ? "Broker Connected" : user ? "Broker Offline" : "Not Authenticated";
  const statusColor = isOnline ? "#1b6f3e" : user ? "#9a5000" : "#888";
  const dotColor    = isOnline ? "#2f9e44" : user ? "#e67700" : "#bbb";

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }

        .nb {
          height: 66px;
          background: #fff;
          border-bottom: 1px solid #e0e0e0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 28px;
          position: sticky;
          top: 0;
          z-index: 100;
          font-family: ${SYS};
        }

        /* Logo */
        .nb-logo {
          display: flex;
          align-items: center;
          gap: 9px;
          text-decoration: none;
          flex-shrink: 0;
        }
        .nb-logo-mark {
          width: 28px;
          height: 28px;
          background: #222;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: ${MONO};
          font-size: 13px;
          font-weight: 700;
          color: #fff;
          flex-shrink: 0;
        }
        .nb-logo-text {
          font-size: 15px;
          font-weight: 700;
          color: #111;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        /* Center status */
        .nb-status {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 5px 12px;
          border: 1px solid #e8e8e8;
          border-radius: 20px;
          background: #fafafa;
        }
        .nb-status-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .nb-status-dot.pulse {
          animation: nbPulse 2s ease-in-out infinite;
        }
        @keyframes nbPulse {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.45; }
        }
        .nb-status-label {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }

        /* Actions */
        .nb-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        /* User chip */
        .nb-user {
          font-family: ${MONO};
          font-size: 11px;
          color: #555;
          padding: 5px 11px;
          background: #f5f5f5;
          border: 1px solid #e0e0e0;
          border-radius: 6px;
          max-width: 200px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* Divider */
        .nb-div {
          width: 1px;
          height: 18px;
          background: #e0e0e0;
          margin: 0 2px;
        }

        /* Buttons */
        .nb-btn {
          font-family: ${SYS};
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.03em;
          text-transform: uppercase;
          border-radius: 6px;
          padding: 7px 14px;
          cursor: pointer;
          border: none;
          text-decoration: none;
          transition: background 0.14s, color 0.14s;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          white-space: nowrap;
        }

        .nb-btn-ghost {
          background: #fff;
          color: #333;
          border: 1px solid #ccc;
        }
        .nb-btn-ghost:hover { background: #f5f5f5; border-color: #999; }

        .nb-btn-primary {
          background: #222;
          color: #fff;
        }
        .nb-btn-primary:hover { background: #3a3a3a; }

        .nb-btn-danger {
          background: #fff;
          color: #c62828;
          border: 1px solid #e0a0a0;
        }
        .nb-btn-danger:hover { background: #fff5f5; border-color: #c62828; }

        /* Skeleton */
        .nb-skeleton {
          width: 76px;
          height: 30px;
          background: #ebebeb;
          border-radius: 6px;
          animation: skPulse 1.4s ease-in-out infinite;
        }
        @keyframes skPulse {
          0%,100% { opacity: 0.5; }
          50%      { opacity: 1; }
        }
      `}</style>

      <nav className="nb">

        {/* Logo */}
        <Link to="/" className="nb-logo">
          <div className="nb-logo-mark">M</div>
          <span className="nb-logo-text">MAT-System</span>
        </Link>

        {/* Center status pill */}
        {!loading && (
          <div className="nb-status">
            <div
              className={`nb-status-dot ${isOnline ? "pulse" : ""}`}
              style={{ background: dotColor }}
            />
            <span className="nb-status-label" style={{ color: statusColor }}>
              {statusLabel}
            </span>
          </div>
        )}

        {/* Right actions */}
        <div className="nb-actions">
          {loading && <div className="nb-skeleton" />}

          {!loading && !user && (
            <Link to="/login" className="nb-btn nb-btn-primary">
              Sign In
            </Link>
          )}

          {!loading && user && !brokerConnected && (
            <>
              <span className="nb-user">{user.email}</span>
              <div className="nb-div" />
              <button className="nb-btn nb-btn-primary" onClick={handleConnectBroker}>
                Connect Broker
              </button>
              <button className="nb-btn nb-btn-danger" onClick={handleLogout}>
                Logout
              </button>
            </>
          )}

          {!loading && user && brokerConnected && (
            <>
              <span className="nb-user">{user.email}</span>
              <div className="nb-div" />
              <Link to="/dashboard" className="nb-btn nb-btn-ghost">
                Dashboard
              </Link>
              <button className="nb-btn nb-btn-danger" onClick={handleLogout}>
                Logout
              </button>
            </>
          )}
        </div>

      </nav>
    </>
  );
}