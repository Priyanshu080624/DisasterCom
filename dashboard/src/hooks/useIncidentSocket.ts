/**
 * Real-time push for the incident feed. Every message from the gateway is a
 * bare signal (`{"type": ..., "incident_id": ...}`) — never a data payload —
 * so on any message we just invalidate the same React Query caches the app
 * already trusts, rather than trying to merge a partial push payload into
 * the cache ourselves.
 *
 * A dropped/failed socket is not a hard failure: the caller's own polling
 * `refetchInterval` keeps working as a slower fallback, so this hook only
 * ever makes things faster when it's connected, never a single point of
 * failure when it isn't.
 *
 * Reliability fixes applied (Task 1):
 *  1. attempt counter resets to 0 on onopen — prevents backoff permanently
 *     pinned at MAX_BACKOFF_MS after a single long outage.
 *  2. Heartbeat ping every 25 s detects silently-dead TCP connections (common
 *     on mobile radios and corporate proxies) before they hit the 20 s backoff ceiling.
 *  3. onIncidentCreated accessed via ref — not in the dependency array — so
 *     a new inline arrow on each render no longer tears down and reopens the socket.
 *  4. visibilitychange reconnects immediately when the user tabs back in after
 *     the OS may have killed the idle socket.
 *
 * Connection quality (Task 2):
 *  5. Returns live `status` ("connected" | "reconnecting" | "offline") so
 *     the dashboard HUD can surface a real-time quality badge without any
 *     additional polling. Status transitions happen entirely inside this hook —
 *     the caller never has to probe the socket directly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const API_KEY = import.meta.env.VITE_API_KEY ?? "dev-coordinator-key";

/** ms between heartbeat pings to detect silently-dead connections */
const HEARTBEAT_INTERVAL_MS = 25_000;

/** maximum reconnect delay so the dashboard is never dark for more than 20 s */
const MAX_BACKOFF_MS = 20_000;

/**
 * Live WebSocket connection quality.
 *
 * - `"connected"`   — socket is OPEN and heartbeat is running
 * - `"reconnecting"` — socket closed and we are waiting to retry (exponential backoff)
 * - `"offline"`     — the gateway itself is unreachable (e.g. REST queries also failing),
 *                    or we have been disconnected for more than one backoff cycle
 */
export type ConnectionStatus = "connected" | "reconnecting" | "offline";

export interface UseIncidentSocketResult {
  /** Live WebSocket connection quality for the HUD badge. */
  status: ConnectionStatus;
}

export function useIncidentSocket(
  queryClient: QueryClient,
  onIncidentCreated?: () => void,
): UseIncidentSocketResult {
  // Stable ref so we always call the latest version of the callback without
  // putting it in the effect dep array. Putting it there caused the socket to
  // close and reopen on every render that passed a new inline arrow function —
  // the root cause of the intermittent connectivity glitch (Task 1 / Fix 3).
  const onCreatedRef = useRef(onIncidentCreated);
  useEffect(() => {
    onCreatedRef.current = onIncidentCreated;
  });

  // Live status for the HUD badge. useState keeps it in React's state graph so
  // any parent that calls this hook re-renders exactly when the socket changes.
  const [status, setStatus] = useState<ConnectionStatus>("reconnecting");

  // Expose a stable setter via ref so closures inside the effect always see
  // the current function pointer without adding it to deps.
  const setStatusRef = useRef(setStatus);

  // Track how long we have been disconnected so we can flip from
  // "reconnecting" → "offline" after a configurable grace period.
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markOffline = useCallback(() => {
    setStatusRef.current("offline");
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let closedByUs = false;
    let attempt = 0; // reset on every successful onopen

    function invalidateAll() {
      queryClient.invalidateQueries({ queryKey: ["incidents"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      queryClient.invalidateQueries({ queryKey: ["incident"] });
      queryClient.invalidateQueries({ queryKey: ["nodes"] });
    }

    function stopHeartbeat() {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: "ping" }));
          } catch {
            // Send failed — connection is silently dead. Close triggers reconnect.
            socket?.close();
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
    }

    /** Start the grace-period timer that downgrades status to "offline" if we
     *  haven't reconnected within MAX_BACKOFF_MS + a small buffer. */
    function scheduleOfflineFlag() {
      if (offlineTimerRef.current !== null) return; // already armed
      offlineTimerRef.current = setTimeout(() => {
        offlineTimerRef.current = null;
        markOffline();
      }, MAX_BACKOFF_MS + 2_000);
    }

    function cancelOfflineFlag() {
      if (offlineTimerRef.current !== null) {
        clearTimeout(offlineTimerRef.current);
        offlineTimerRef.current = null;
      }
    }

    function connect() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      const wsUrl = `${API_URL.replace(/^http/, "ws")}/v1/ws/incidents?token=${API_KEY}`;
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        // Fix 1: reset attempt so the next failure starts back at 1 s backoff,
        // not wherever the last outage left the counter.
        attempt = 0;
        startHeartbeat(); // Fix 2: begin heartbeat pings

        // Task 2: update live status badge
        cancelOfflineFlag();
        setStatusRef.current("connected");
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "pong") return; // our own heartbeat echo, ignore
          invalidateAll();
          if (data.type === "incident_created") onCreatedRef.current?.(); // Fix 3: via ref
        } catch {
          // malformed message — just refetch, do not fail
          invalidateAll();
        }
      };

      socket.onclose = () => {
        stopHeartbeat();
        if (closedByUs) return;
        attempt += 1;

        // Task 2: flip status → reconnecting and arm the offline downgrade timer
        setStatusRef.current("reconnecting");
        scheduleOfflineFlag();

        // Exponential backoff + up to 300 ms jitter so multiple tabs don't
        // hammer the server at the exact same moment after a shared outage.
        const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
        const jitter = Math.random() * 300;
        reconnectTimer = setTimeout(connect, base + jitter);
      };

      socket.onerror = () => {
        // onerror is always followed by onclose in browsers; reconnect logic lives there.
        socket?.close();
      };
    }

    // Fix 4: reconnect immediately when the tab becomes visible again — the OS
    // may have killed the idle socket while the user was away.
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        if (socket === null || socket.readyState === WebSocket.CLOSED) {
          attempt = 0; // tab-switch is a fresh start, not a failure count
          connect();
        }
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    connect();

    return () => {
      closedByUs = true;
      stopHeartbeat();
      cancelOfflineFlag();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      socket?.close();
    };
  // queryClient is stable (created once in main.tsx).
  // onIncidentCreated is intentionally accessed via ref — see comment above.
  // markOffline is useCallback-stable and does not contain closures over effect state.
  }, [queryClient, markOffline]);

  return { status };
}
