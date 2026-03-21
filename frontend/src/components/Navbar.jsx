import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../components/Authcontext.jsx";
import axios from "axios";
import { useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const SYS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

export default function Navbar() {
  const navigate = useNavigate();
  const { user, brokerConnected, loading, setUser, setBrokerConnected } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogout = async () => {
    try {
      await api.post("/auth/logout");
      setUser(null);
      setBrokerConnected(false);
      setMenuOpen(false);
      navigate("/login");
    } catch {
      console.error("Logout failed");
    }
  };

  const handleConnectBroker = async () => {
    try {
      const res = await api.post("/broker/connect");
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
  const dotColor = isOnline ? "#2f9e44" : user ? "#e67700" : "#bbb";

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }

        /* ── NAV SHELL ── */
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

        /* ── LOGO ── */
        .nb-logo {
          display: flex; align-items: center; gap: 9px;
          text-decoration: none; flex-shrink: 0;
        }
        .nb-logo-mark {
          width: 28px; height: 28px;
          background: #222; border-radius: 6px;
          display: flex; align-items: center; justify-content: center;
          font-family: ${MONO}; font-size: 13px; font-weight: 700; color: #fff;
          flex-shrink: 0;
        }
        .nb-logo-text {
          font-size: 18px; font-weight: 700;
          color: #111; letter-spacing: 0.04em; text-transform: uppercase;
        }

        /* ── STATUS PILL ── */
        .nb-status {
          display: flex; align-items: center; gap: 7px;
          padding: 5px 12px;
          border: 1px solid #e8e8e8; border-radius: 20px;
          background: #fafafa;
          flex-shrink: 0;
        }
        .nb-status-dot {
          width: 7px; height: 7px;
          border-radius: 50%; flex-shrink: 0;
        }
        .nb-status-dot.pulse { animation: nbPulse 2s ease-in-out infinite; }
        @keyframes nbPulse {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.45; }
        }
        .nb-status-label {
          font-size: 11px; font-weight: 600;
          letter-spacing: 0.06em; text-transform: uppercase;
          white-space: nowrap;
        }

        /* ── DESKTOP ACTIONS ── */
        .nb-actions {
          display: flex; align-items: center; gap: 8px; flex-shrink: 0;
        }

        .nb-user {
          font-family: ${MONO}; font-size: 11px; color: #555;
          padding: 5px 11px;
          background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 6px;
          max-width: 160px; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap;
        }

        .nb-div { width: 1px; height: 18px; background: #e0e0e0; margin: 0 2px; }

        .nb-btn {
          font-family: ${SYS}; font-size: 12px; font-weight: 600;
          letter-spacing: 0.03em; text-transform: uppercase;
          border-radius: 6px; padding: 7px 14px;
          cursor: pointer; border: none; text-decoration: none;
          transition: background 0.14s, color 0.14s;
          display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
        }
        .nb-btn-primary { background: #222; color: #fff; }
        .nb-btn-primary:hover { background: #3a3a3a; }
        .nb-btn-danger  { background: #fff; color: #c62828; border: 1px solid #e0a0a0; }
        .nb-btn-danger:hover { background: #fff5f5; border-color: #c62828; }

        /* Full-width buttons for mobile drawer */
        .nb-btn-full {
          width: 100%; justify-content: center;
          padding: 11px 14px; font-size: 13px;
        }

        /* ── SKELETON ── */
        .nb-skeleton {
          width: 76px; height: 30px;
          background: #ebebeb; border-radius: 6px;
          animation: skPulse 1.4s ease-in-out infinite;
        }
        @keyframes skPulse {
          0%,100% { opacity: 0.5; }
          50%      { opacity: 1; }
        }

        /* ── HAMBURGER ── */
        .nb-hamburger {
          display: none;
          flex-direction: column; justify-content: center; align-items: center;
          gap: 5px;
          width: 38px; height: 38px;
          background: none; border: 1px solid #e0e0e0;
          border-radius: 6px; cursor: pointer; padding: 0;
          flex-shrink: 0;
        }
        .nb-hamburger span {
          display: block; width: 18px; height: 2px;
          background: #333; border-radius: 2px;
          transition: transform 0.22s, opacity 0.22s;
          transform-origin: center;
        }
        .nb-hamburger.open span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
        .nb-hamburger.open span:nth-child(2) { opacity: 0; transform: scaleX(0); }
        .nb-hamburger.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }

        /* ── MOBILE DRAWER ── */
        .nb-drawer {
          display: none;
          position: fixed;
          top: 66px; left: 0; right: 0;
          background: #fff;
          border-bottom: 1px solid #e0e0e0;
          padding: 16px 20px 20px;
          z-index: 99;
          flex-direction: column;
          gap: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.08);
        }
        .nb-drawer.open { display: flex; }

        .nb-drawer-user {
          font-family: ${MONO}; font-size: 11px; color: #555;
          padding: 8px 11px;
          background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 6px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          text-align: center;
        }

        /* ── RESPONSIVE BREAKPOINTS ── */

        /* Tablet: hide user email text from desktop bar, keep icons tighter */
        @media (max-width: 768px) {
          .nb { padding: 0 16px; }
          .nb-hamburger { display: flex; }
          .nb-actions { display: none; }
          .nb-logo-text { font-size: 15px; }
        }

        /* Small mobile: tighten logo further */
        @media (max-width: 380px) {
          .nb { padding: 0 12px; }
          .nb-logo-text { font-size: 13px; letter-spacing: 0.02em; }
          .nb-logo-mark { width: 24px; height: 24px; font-size: 11px; }
        }
      `}</style>

      <nav className="nb">

        {/* Logo */}
        <Link to="/" className="nb-logo">
          <div className="nb-logo-mark">M</div>
          <span className="nb-logo-text">MAT-System</span>
        </Link>

        {/* Desktop right actions */}
        <div className="nb-actions">
          {loading && <div className="nb-skeleton" />}

          {!loading && (
            <div className="nb-status">
              <div className={`nb-status-dot ${isOnline ? "pulse" : ""}`} style={{ background: dotColor }} />
              <span className="nb-status-label" style={{ color: statusColor }}>{statusLabel}</span>
            </div>
          )}

          {!loading && !user && (
            <Link to="/login" className="nb-btn nb-btn-primary">Sign In</Link>
          )}

          {!loading && user && !brokerConnected && (
            <>
              <span className="nb-user">{user.email}</span>
              <div className="nb-div" />
              <button className="nb-btn nb-btn-primary" onClick={handleConnectBroker}>Connect Broker</button>
              <button className="nb-btn nb-btn-danger" onClick={handleLogout}>Logout</button>
            </>
          )}

          {!loading && user && brokerConnected && (
            <>
              <span className="nb-user">{user.email}</span>
              <div className="nb-div" />
              <button className="nb-btn nb-btn-danger" onClick={handleLogout}>Logout</button>
            </>
          )}
        </div>

        {/* Mobile hamburger */}
        <button
          className={`nb-hamburger ${menuOpen ? "open" : ""}`}
          onClick={() => setMenuOpen(o => !o)}
          aria-label="Toggle menu"
        >
          <span /><span /><span />
        </button>
      </nav>

      {/* Mobile drawer */}
      <div className={`nb-drawer ${menuOpen ? "open" : ""}`}>

        {loading && <div className="nb-skeleton" style={{ width: "100%", height: 36 }} />}

        {/* Status pill (always shown) */}
        {!loading && (
          <div className="nb-status" style={{ justifyContent: "center" }}>
            <div className={`nb-status-dot ${isOnline ? "pulse" : ""}`} style={{ background: dotColor }} />
            <span className="nb-status-label" style={{ color: statusColor }}>{statusLabel}</span>
          </div>
        )}

        {!loading && !user && (
          <Link to="/login" className="nb-btn nb-btn-primary nb-btn-full" onClick={() => setMenuOpen(false)}>
            Sign In
          </Link>
        )}

        {!loading && user && (
          <div className="nb-drawer-user">{user.email}</div>
        )}

        {!loading && user && !brokerConnected && (
          <button
            className="nb-btn nb-btn-primary nb-btn-full"
            onClick={() => { setMenuOpen(false); handleConnectBroker(); }}
          >
            Connect Broker
          </button>
        )}

        {!loading && user && (
          <button
            className="nb-btn nb-btn-danger nb-btn-full"
            onClick={handleLogout}
          >
            Logout
          </button>
        )}
      </div>
    </>
  );
}