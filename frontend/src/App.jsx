import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";
import { AuthProvider } from "./components/Authcontext.jsx";
import Navbar from "./components/Navbar.jsx";
import Home from "./pages/home.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import DeployStrategy from "./pages/Deploystrategy.jsx";
import Footer from "./components/Footer.jsx";

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

          {/* Routes WITH Navbar */}
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />
            <Route path="/dashboard" element={<Home />} />
            <Route path="/deploy" element={<DeployStrategy />} />
          </Route>

          {/* Routes WITHOUT Navbar */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;