import { useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useAuth } from "../components/Authcontext.jsx";
import axios from "axios";
import AuthGate from "../components/Authgate.jsx";
import Dashboard from "./Dashboard.jsx";
import toast from "react-hot-toast"; 

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

export default function Home() {
  const { user, brokerConnected, loading, refresh } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Handle broker OAuth callback
  useEffect(() => {
    const handle = async () => {
      const brokerStatus = searchParams.get("status");

      if (brokerStatus === "connected") {
        await refresh();
        navigate("/dashboard", { replace: true });
        toast.success("Broker connected successfully!");
        
      }

      if (brokerStatus === "error") {
        const brokerReason = searchParams.get("reason") || "unknown_error";
        navigate("/", { replace: true });
        toast.error(`Broker connection failed: ${brokerReason}`);
        
      }
    };
    handle();
  }, []);

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

  const state = loading
    ? "loading"
    : !user
    ? "unauthenticated"
    : !brokerConnected
    ? "no-broker"
    : "ready";

  if (state !== "ready") {
    return <AuthGate state={state} onConnectBroker={handleConnectBroker} />;
  }

  return <Dashboard />;
}