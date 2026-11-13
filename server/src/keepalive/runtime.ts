import type { EngineAccess } from '~/_engine/access.ts';

const MAX_RECENT_LATENCIES = 5;

/** The quality tiers a measured round-trip time can fall into. */
type Quality = 'excellent' | 'good' | 'degraded' | 'poor';

/** Map a round-trip time in milliseconds to a readable connection quality. */
function qualityFromLatency(latency: number): Quality {
  if (latency < 100) return 'excellent';

  if (latency < 300) return 'good';

  if (latency < 1000) return 'degraded';

  return 'poor';
}

/** What the monitor remembers about one connection it is pinging. */
interface WatchedConnection {
  pingTimer?: ReturnType<typeof setTimeout>;
  /** When the one unanswered ping went out. A pong carries no id, so only one ping is sent at a time. */
  pingSentAt: number | null;
  recentLatencies: number[];
  latency: number | null;
}

/** The two timings `keepalive()` was configured with. */
export interface KeepaliveTimings {
  readonly pingIntervalMs: number;
  readonly idleTimeoutMs: number;
}

/**
 * Watches connections on behalf of `keepalive()`: pings each one on a timer,
 * times the pong that comes back, and keeps an idle window open so a connection
 * that stops sending anything is closed.
 *
 * All of the state lives here rather than on the engine's connection record,
 * because a server that never lists `keepalive()` measures nothing and should
 * carry nothing.
 */
export interface KeepaliveMonitor {
  /** Begin pinging a newly connected socket and open its idle window. */
  watch(connectionId: string): void;
  /** Reopen a connection's idle window after any inbound frame. */
  touch(connectionId: string): void;
  /** Time the round-trip a returning pong just completed. */
  recordPong(connectionId: string): void;
  /** Forget a connection and cancel its ping timer. */
  forget(connectionId: string): void;
}

/**
 * Build the monitor `keepalive()` drives. `supervises` decides, per connection, whether
 * this monitor does anything at all for it: pinging it AND arming its idle timer. For a
 * connection the platform holds while the server sleeps, neither can work — the runtime
 * answers a client's ping at the edge, so a server ping would only wake the instance and
 * could never be timed, and a `setTimeout` idle timer would itself hold the instance in
 * memory, defeating hibernation, while producing false disconnects for quiet-but-alive
 * clients whose traffic never reaches the instance to refresh it.
 */
export function createKeepaliveMonitor(
  engine: Pick<EngineAccess, 'sendPing' | 'setConnectionLatency' | 'refreshConnectionIdleTimeout'>,
  timings: KeepaliveTimings,
  supervises: (connectionId: string) => boolean,
): KeepaliveMonitor {
  const watched = new Map<string, WatchedConnection>();

  function schedulePing(connectionId: string, connection: WatchedConnection): void {
    connection.pingTimer = setTimeout(() => {
      if (connection.pingSentAt !== null) {
        // No ping goes out here to notice a closed socket, so ask the registry.
        if (engine.setConnectionLatency(connectionId, connection.latency, 'poor') === false) return;

        schedulePing(connectionId, connection);
        return;
      }

      // The timer can fire in the same tick the socket is closing — most visibly
      // when the ping interval is half the idle timeout, so a ping lands exactly
      // on the close deadline. Sending then throws; end the loop rather than let
      // an uncaught error escape a timer callback.
      let sent: boolean;
      try {
        sent = engine.sendPing(connectionId);
      } catch {
        return;
      }

      // The connection can also be gone from the registry, or its socket can
      // refuse the frame while closing. Stop the loop the same way rather than
      // pinging a connection that will never answer again.
      if (sent === false) return;

      connection.pingSentAt = Date.now();
      schedulePing(connectionId, connection);
    }, timings.pingIntervalMs);
  }

  return {
    watch(connectionId) {
      if (watched.has(connectionId)) return;

      if (!supervises(connectionId)) return;

      const connection: WatchedConnection = {
        pingSentAt: null,
        recentLatencies: [],
        latency: null,
      };

      watched.set(connectionId, connection);
      engine.refreshConnectionIdleTimeout(connectionId, timings.idleTimeoutMs);
      schedulePing(connectionId, connection);
    },

    touch(connectionId) {
      if (!supervises(connectionId)) return;

      engine.refreshConnectionIdleTimeout(connectionId, timings.idleTimeoutMs);
    },

    recordPong(connectionId) {
      const connection = watched.get(connectionId);
      if (connection === undefined || connection.pingSentAt === null) return;

      const sample = Date.now() - connection.pingSentAt;
      connection.pingSentAt = null;
      connection.recentLatencies = [...connection.recentLatencies, sample].slice(
        -MAX_RECENT_LATENCIES,
      );

      const total = connection.recentLatencies.reduce((sum, value) => sum + value, 0);
      const average = Math.round(total / connection.recentLatencies.length);

      connection.latency = average;
      engine.setConnectionLatency(connectionId, average, qualityFromLatency(average));
    },

    forget(connectionId) {
      const connection = watched.get(connectionId);
      if (connection?.pingTimer !== undefined) clearTimeout(connection.pingTimer);
      watched.delete(connectionId);
    },
  };
}
