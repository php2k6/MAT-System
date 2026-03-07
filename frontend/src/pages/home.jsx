import { useAuth } from "../components/Authcontext.jsx";
import axios from "axios";
import AuthGate from "../components/Authgate.jsx";
import Dashboard from "./Dashboard.jsx";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

export default function Home() {
  const { user, brokerConnected, loading } = useAuth();

  const handleConnectBroker = async () => {
    try {
      const res = await api.post("/broker/connect");
      if (res.data.success && res.data.redirectUrl) {
        window.location.href = res.data.redirectUrl; // ✅ OAuth redirect
      }
    } catch (err) {
      console.error("Broker connection failed", err);
    }
  };

  // Derive state from shared auth context
  const state = loading
    ? "loading"
    : !user
    ? "unauthenticated"
    : !brokerConnected
    ? "no-broker"
    : "ready";

  if (state !== "ready") {
    return (
      <AuthGate
        state={state}
        onConnectBroker={handleConnectBroker}
      />
    );
  }

  return <Dashboard />;
}