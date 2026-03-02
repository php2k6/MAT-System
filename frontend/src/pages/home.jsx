import { useEffect, useState } from "react";
import axios from "axios";
import AuthGate from "../components/Authgate.jsx";
import Dashboard from "./Dashboard.jsx";


export default function Home() {
  const [state, setState] = useState("loading");

  const api = axios.create({
    baseURL: "http://localhost:5000/api",
    withCredentials: true
  });

  useEffect(() => {
    const initialize = async () => {
      try {
        // Run in parallel (important)
        const [authRes, brokerRes] = await Promise.all([
          api.get("/auth/me"),
          api.get("/broker/status")
        ]);

        if (!authRes.data.user) {
          setState("unauthenticated");
          return;
        }

        if (!brokerRes.data.brokerConnected) {
          setState("no-broker");
          return;
        }

        setState("ready"); // Fully active
      } catch (err) {
        setState("unauthenticated");
      }
    };

    initialize();
  }, []);

  const handleConnectBroker = async () => {
    try {
      await api.post("/broker/connect");
      setState("ready");
    } catch (err) {
      console.error("Broker connection failed");
    }
  };

  // 🔥 If not ready, show AuthGate
  if (state !== "ready") {
    return (
        
      <AuthGate
        state={state}
        onConnectBroker={handleConnectBroker}
      />
    );
  }

  // ✅ REAL DASHBOARD CONTENT
  return (
   <Dashboard/>
  );
}