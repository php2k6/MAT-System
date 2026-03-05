import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";


const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;


// ─── API SERVICE LAYER ────────────────────────────────────────────────────────
const api = axios.create({
  baseURL: `${API_BASE_URL}`,
  withCredentials: true,
});

const authService = {
  getMe:          () => api.get("/auth/me"),
  logout:         () => api.post("/auth/logout"),
  getBrokerStatus:() => api.get("/broker/status"),
  connectBroker:  () => api.post("/broker/connect"),
};
// ─────────────────────────────────────────────────────────────────────────────

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
      // The backend returns the URL for the broker's OAuth page
      if (res.data.success && res.data.redirectUrl) {
        // Use window.location.href to leave your app and go to the broker
        window.location.href = res.data.redirectUrl; 
      }
    } catch (err) {
      console.error("Broker connection failed", err);
    }
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;800&family=JetBrains+Mono:wght@400;500&display=swap');

        .mat-nav {
          height: 60px;
          background: #060a12;
          border-bottom: 1px solid rgba(0,229,160,0.1);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 32px;
          position: sticky;
          top: 0;
          z-index: 100;
        }

        /* Logo */
        .mat-nav-logo {
          display: flex;
          align-items: center;
          gap: 10px;
          text-decoration: none;
        }
        .mat-nav-logo-mark {
          width: 28px;
          height: 28px;
          background: linear-gradient(135deg, #00e5a0, #00b8d9);
          border-radius: 7px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          font-weight: 500;
          color: #060a12;
        }
        .mat-nav-logo-text {
          font-family: 'Syne', sans-serif;
          font-size: 15px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #fff;
        }

        /* Status pill */
        .mat-nav-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 0.08em;
          color: rgba(255,255,255,0.3);
          padding: 4px 10px;
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 20px;
        }
        .mat-nav-status-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #00e5a0;
          box-shadow: 0 0 5px #00e5a0;
          animation: navDotPulse 2s ease-in-out infinite;
        }
        .mat-nav-status-dot.offline { background: #ff4d6d; box-shadow: 0 0 5px #ff4d6d; animation: none; }
        @keyframes navDotPulse {
          0%,100%{opacity:1} 50%{opacity:0.4}
        }

        /* Actions */
        .mat-nav-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        /* Shared button base */
        .mat-nav-btn {
          font-family: 'Syne', sans-serif;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          border-radius: 8px;
          padding: 7px 16px;
          cursor: pointer;
          border: none;
          text-decoration: none;
          transition: opacity 0.15s, transform 0.15s;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .mat-nav-btn:hover { opacity: 0.85; transform: translateY(-1px); }
        .mat-nav-btn:active { transform: translateY(0); }

        .mat-nav-btn-ghost {
          background: rgba(255,255,255,0.05);
          color: rgba(255,255,255,0.6);
          border: 1px solid rgba(255,255,255,0.08);
        }
        .mat-nav-btn-primary {
          background: linear-gradient(135deg, #00e5a0, #00c98c);
          color: #060a12;
        }
        .mat-nav-btn-danger {
          background: rgba(255,77,109,0.12);
          color: #ff4d6d;
          border: 1px solid rgba(255,77,109,0.2);
        }

        /* Loading skeleton */
        .mat-nav-skeleton {
          width: 80px;
          height: 30px;
          background: rgba(255,255,255,0.04);
          border-radius: 8px;
          animation: skeletonPulse 1.4s ease-in-out infinite;
        }
        @keyframes skeletonPulse {
          0%,100%{opacity:0.4} 50%{opacity:0.9}
        }

        /* User chip */
        .mat-nav-user {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: rgba(255,255,255,0.35);
          padding: 6px 12px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 8px;
          letter-spacing: 0.05em;
        }

        .mat-nav-divider {
          width: 1px;
          height: 20px;
          background: rgba(255,255,255,0.08);
          margin: 0 4px;
        }
      `}</style>

      <nav className="mat-nav">
        {/* Logo */}
        <Link to="/" className="mat-nav-logo">
          <div className="mat-nav-logo-mark">M</div>
          <span className="mat-nav-logo-text">MAT-System</span>
        </Link>

        {/* Center status */}
        {!loading && (
          <div className="mat-nav-status">
            <div className={`mat-nav-status-dot ${user && brokerConnected ? "" : "offline"}`} />
            {user && brokerConnected ? "BROKER CONNECTED" : user ? "BROKER OFFLINE" : "NOT AUTHENTICATED"}
          </div>
        )}

        {/* Actions */}
        <div className="mat-nav-actions">
          {loading && <div className="mat-nav-skeleton" />}

          {!loading && !user && (
            <Link to="/login" className="mat-nav-btn mat-nav-btn-primary">
              Sign In
            </Link>
          )}

          {!loading && user && !brokerConnected && (
            <>
              <span className="mat-nav-user">{user.email}</span>
              <div className="mat-nav-divider" />
              <button className="mat-nav-btn mat-nav-btn-primary" onClick={handleConnectBroker}>
                Connect Broker
              </button>
              <button className="mat-nav-btn mat-nav-btn-danger" onClick={handleLogout}>
                Logout
              </button>
            </>
          )}

          {!loading && user && brokerConnected && (
            <>
              <span className="mat-nav-user">{user.email}</span>
              <div className="mat-nav-divider" />
              <Link to="/dashboard" className="mat-nav-btn mat-nav-btn-ghost">
                Dashboard
              </Link>
              <button className="mat-nav-btn mat-nav-btn-danger" onClick={handleLogout}>
                Logout
              </button>
            </>
          )}
        </div>
      </nav>
    </>
  );
}