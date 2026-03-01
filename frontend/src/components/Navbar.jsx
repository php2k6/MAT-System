import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";

export default function Navbar() {
  const navigate = useNavigate();

  const [user, setUser] = useState(null);
  const [brokerConnected, setBrokerConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  const api = axios.create({
    baseURL: "http://localhost:5000/api",
    withCredentials: true
  });

  // Check auth + broker status on load
  useEffect(() => {
    const initialize = async () => {
      try {
        const authRes = await api.get("/auth/me");
        setUser(authRes.data.user);

        const brokerRes = await api.get("/broker/status");
        setBrokerConnected(brokerRes.data.brokerConnected);
      } catch (err) {
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    initialize();
  }, []);

  const handleLogout = async () => {
    try {
      await api.post("/auth/logout");
      setUser(null);
      setBrokerConnected(false);
      navigate("/login");
    } catch (err) {
      console.error("Logout failed");
    }
  };

  const handleConnectBroker = async () => {
    try {
      await api.post("/broker/connect");
      setBrokerConnected(true);
      navigate("/dashboard");
    } catch (err) {
      console.error("Broker connection failed");
    }
  };

  if (loading) return null;

  return (
    <nav style={styles.nav}>
      <div style={styles.logo}>MAT System</div>

      <div style={styles.actions}>
        {/* Not Logged In */}
        {!user && (
          <Link to="/login" style={styles.button}>
            Login
          </Link>
        )}

        {/* Logged In but Broker Not Connected */}
        {user && !brokerConnected && (
          <button
            style={styles.connectButton}
            onClick={handleConnectBroker}
          >
            Connect Broker
          </button>
        )}

        {/* Fully Active User */}
        {user && brokerConnected && (
          <>
            <Link to="/dashboard" style={styles.button}>
              Dashboard
            </Link>

            <button style={styles.logoutButton} onClick={handleLogout}>
              Logout
            </button>
          </>
        )}
      </div>
    </nav>
  );
}

const styles = {
  nav: {
    height: "60px",
    background: "#0f172a",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0 40px",
    borderBottom: "1px solid rgba(34,197,94,0.2)"
  },
  logo: {
    color: "#22c55e",
    fontSize: "18px",
    fontWeight: "bold"
  },
  actions: {
    display: "flex",
    gap: "15px"
  },
  button: {
    background: "#1e293b",
    color: "#94a3b8",
    padding: "8px 14px",
    borderRadius: "6px",
    textDecoration: "none",
    fontSize: "14px"
  },
  connectButton: {
    background: "#22c55e",
    color: "#0f172a",
    padding: "8px 14px",
    borderRadius: "6px",
    border: "none",
    fontWeight: "bold",
    cursor: "pointer"
  },
  logoutButton: {
    background: "#ef4444",
    color: "white",
    padding: "8px 14px",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer"
  }
};