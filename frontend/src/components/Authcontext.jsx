// AuthContext.jsx
import { createContext, useContext, useEffect, useState } from "react";
import axios from "axios";

const AuthContext = createContext(null);
const api = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL, withCredentials: true });

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [brokerConnected, setBrokerConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const [authRes, brokerRes] = await Promise.all([
        api.get("/auth/me"),
        api.get("/broker/status"),
      ]);
      setUser(authRes.data.user);
      setBrokerConnected(brokerRes.data.brokerConnected);
    } catch {
      setUser(null);
      setBrokerConnected(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  return (
    <AuthContext.Provider value={{ user, brokerConnected, loading, setUser, setBrokerConnected, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);