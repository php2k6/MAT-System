import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";

// ─── LAYOUT ───────────────────────────────────────────────────────────────────
// Wraps every page: Sidebar on the left, page content on the right.
// <Outlet /> renders the matched child route (Dashboard, Deploy, History, etc.)

export default function AppLayout() {
  return (
    <>
      <style>{`
        .layout-root {
          display: flex;
          min-height: calc(100vh - 56px); /* subtract your navbar height */
          background: #f2f2f2;
        }
        .layout-main {
          flex: 1;
          min-width: 0; /* prevents flex overflow */
          overflow-x: hidden;
        }
      `}</style>

      <div className="layout-root">
        <Sidebar />
        <main className="layout-main">
          <Outlet />
        </main>
      </div>
    </>
  );
}
