import { API_BASE_URL } from "./constants.js";

// ─── API SERVICE LAYER ────────────────────────────────────────────────────────
export const api = {
  getPortfolio: async () => {
    const res = await fetch(`${API_BASE_URL}/portfolio`, {
      method: "GET",
      credentials: "include",
    });
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    if (!res.ok) throw new Error(`Portfolio fetch failed: ${res.status}`);
    return res.json();
  },

  getChartData: async (range = "1M") => {
    const res = await fetch(
      `${API_BASE_URL}/portfolio/chart?range=${encodeURIComponent(range)}`,
      { method: "GET", credentials: "include" }
    );
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    if (res.status === 400) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.detail?.message || "Invalid range");
    }
    if (!res.ok) throw new Error(`Chart fetch failed: ${res.status}`);
    return res.json();
  },

  postAction: async (action) => {
    const res = await fetch(`${API_BASE_URL}/strategy/action`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    if (!res.ok) throw new Error(`Action failed: ${res.status}`);
    return res.json();
  },
};
