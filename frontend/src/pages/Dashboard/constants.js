// ─── CONSTANTS ────────────────────────────────────────────────────────────────
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
export const WS_BASE_URL  = import.meta.env.VITE_WS_BASE_URL
  || API_BASE_URL.replace(/^http/, "ws"); // http->ws, https->wss

export const CHART_RANGES = ["1W", "1M", "3M", "1Y", "3Y", "5Y", "10Y", "MAX"];

export const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
export const MONO = `'Courier New', Courier, monospace`;

export const STATUS_CONFIG = {
  active:  { label: "Active",  bg: "#dcfce7", color: "#15803d", dot: "#22c55e", ring: "#bbf7d0" },
  paused:  { label: "Paused",  bg: "#fef9c3", color: "#a16207", dot: "#eab308", ring: "#fef08a" },
  stopped: { label: "Stopped", bg: "#fee2e2", color: "#b91c1c", dot: "#ef4444", ring: "#fecaca" },
};
