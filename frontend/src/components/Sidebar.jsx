import { NavLink, useLocation } from "react-router-dom";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

const NAV_ITEMS = [
  {
    path: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
        <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
        <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
        <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
      </svg>
    ),
  },
  {
    path: "/deploy",
    label: "Backtest / Deploy",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <polyline points="1,11 5,6 8,9 11,4 15,7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        <polyline points="11,4 15,4 15,8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    path: "/history",
    label: "History",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4"/>
        <polyline points="8,4.5 8,8 10.5,10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    path: "/profile",
    label: "Profile",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.4"/>
        <path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
];

// ─── SIDEBAR COMPONENT ────────────────────────────────────────────────────────
export default function Sidebar() {
  return (
    <>
      <style>{`
        .sb-root {
          width: 220px;
          min-height: calc(100vh - 56px);
          background: #fff;
          border-right: 1px solid #e0e0e0;
          display: flex;
          flex-direction: column;
          padding: 20px 12px 32px;
          position: sticky;
          top: 56px;       /* adjust to match your navbar height */
          height: calc(100vh - 56px);
          flex-shrink: 0;
          font-family: ${SYS};
        }

        .sb-section-label {
          font-size: 9px;
          font-weight: 700;
          color: #bbb;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          padding: 0 10px;
          margin-bottom: 6px;
          margin-top: 8px;
        }

        .sb-nav {
          display: flex;
          flex-direction: column;
          gap: 2px;
          list-style: none;
        }

        .sb-link {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 9px 10px;
          border-radius: 7px;
          font-size: 13px;
          font-weight: 500;
          color: #666;
          text-decoration: none;
          transition: background 0.13s, color 0.13s;
          cursor: pointer;
          border: none;
          background: transparent;
          width: 100%;
          text-align: left;
        }

        .sb-link:hover {
          background: #f5f5f5;
          color: #111;
        }

        .sb-link.active {
          background: #111;
          color: #fff;
        }

        .sb-link.active .sb-icon {
          opacity: 1;
        }

        .sb-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          opacity: 0.7;
        }

        .sb-link.active .sb-icon {
          opacity: 1;
        }

        .sb-divider {
          height: 1px;
          background: #ebebeb;
          margin: 12px 6px;
        }

        .sb-footer {
          margin-top: auto;
          padding: 10px 10px 0;
          font-size: 10px;
          color: #ccc;
          font-family: ${MONO};
          letter-spacing: 0.04em;
        }

        /* Responsive: collapse to icon-only bar on small screens */
        @media (max-width: 768px) {
          .sb-root {
            width: 56px;
            padding: 16px 8px;
            align-items: center;
          }
          .sb-link-label,
          .sb-section-label,
          .sb-footer {
            display: none;
          }
          .sb-link {
            padding: 10px;
            justify-content: center;
          }
          .sb-icon {
            opacity: 0.7;
          }
          .sb-link.active .sb-icon {
            opacity: 1;
          }
        }
      `}</style>

      <aside className="sb-root">
        <div className="sb-section-label">Navigation</div>

        <ul className="sb-nav">
          {NAV_ITEMS.map(({ path, label, icon }) => (
            <li key={path}>
              <NavLink
                to={path}
                className={({ isActive }) => `sb-link${isActive ? " active" : ""}`}
              >
                <span className="sb-icon">{icon}</span>
                <span className="sb-link-label">{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="sb-divider" />

        <div className="sb-footer">v1.0.0</div>
      </aside>
    </>
  );
}
