import { useState, useEffect, useRef, useCallback } from "react";
import { WS_BASE_URL } from "./constants";

// ─── WEBSOCKET HOOK ───────────────────────────────────────────────────────────
export function useLiveWebSocket({
  enabled,
  onHoldingsUpdate,
  onPositionsUpdate,   // ← NEW
  onSummaryUpdate,
  onUnauthorized,
}) {
  const wsRef          = useRef(null);
  const reconnectTimer = useRef(null);
  const unmounted      = useRef(false);
  const reconnectCount = useRef(0);
  const MAX_RECONNECTS = 5;
  const [wsStatus, setWsStatus] = useState("disconnected");

  const connect = useCallback(() => {
    if (!enabled || unmounted.current) return;
    if (wsRef.current && wsRef.current.readyState < 2) return;

    setWsStatus("connecting");
    const ws = new WebSocket(`${WS_BASE_URL}/live/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!unmounted.current) {
        setWsStatus("live");
        reconnectCount.current = 0;
      }
    };

    ws.onmessage = (event) => {
      if (unmounted.current) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case "holdings_update":
          if (Array.isArray(msg.items) && msg.items.length > 0) {
            onHoldingsUpdate(msg.items);
          }
          break;
        case "positions_update":                                  // ← NEW
          if (Array.isArray(msg.items) && msg.items.length > 0) {
            onPositionsUpdate(msg.items);
          }
          break;
        case "summary_update":
          if (msg.summary) {
            onSummaryUpdate(msg.summary);
          }
          break;
        case "status":
          if (msg.message === "NO_STRATEGY") {
            setWsStatus("no_strategy");
          }
          break;
        case "error":
          if (msg.message === "Unauthorized") {
            onUnauthorized();
          }
          break;
        default:
          break;
      }
    };

    ws.onerror = () => {
      if (!unmounted.current) setWsStatus("disconnected");
    };

    ws.onclose = (event) => {
      if (unmounted.current) return;

      if (event.code === 4401) {
        setWsStatus("disconnected");
        onUnauthorized();
        return;
      }

      reconnectCount.current++;

      if (reconnectCount.current >= MAX_RECONNECTS) {
        console.error("Max WebSocket reconnection attempts reached");
        setWsStatus("disconnected");
        return;
      }

      setWsStatus("disconnected");
      const backoffDelay = 4000 * reconnectCount.current;
      reconnectTimer.current = setTimeout(() => {
        if (!unmounted.current) connect();
      }, backoffDelay);
    };
  }, [enabled, onHoldingsUpdate, onPositionsUpdate, onSummaryUpdate, onUnauthorized]);

  useEffect(() => {
    unmounted.current = false;
    if (enabled) connect();

    return () => {
      unmounted.current = true;
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [enabled, connect]);

  return wsStatus;
}