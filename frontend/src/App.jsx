import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";
import { AuthProvider } from "./components/Authcontext.jsx";
import Navbar from "./components/Navbar.jsx";
import Home from "./pages/home.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import DeployStrategy from "./pages/Deploystrategy.jsx";
import Footer from "./components/Footer.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import AppLayout from "./components/AppLayout.jsx";

function Layout() {
  return (
    <>
      <Navbar />
      <Outlet />
      <Footer />
    </>
  );
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>

          {/* Routes WITH Navbar + Sidebar */}
          <Route element={<Layout />}>
            <Route element={<AppLayout />}>
              <Route path="/" element={<Home />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/deploy" element={<DeployStrategy />} />
            </Route>
          </Route>  {/* ← this closing tag was missing */}

          {/* Routes WITHOUT Navbar */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;