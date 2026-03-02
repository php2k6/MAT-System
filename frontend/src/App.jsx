import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";
import Navbar from "./components/navbar.jsx";
import Home from "./pages/home.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import DeployStrategy from "./pages/Deploystrategy.jsx";
import Footer from "./components/Footer.jsx";

// ✅ Layout component inside same file
function Layout() {
  return (
    <>
      <Navbar />
      <Outlet />
      <Footer/>
    </>
  );
}

function App() {
  return (
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
  );
}

export default App;