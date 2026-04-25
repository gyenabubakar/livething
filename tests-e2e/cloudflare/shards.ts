/**
 * Wrangler shard definitions.
 *
 * Each shard is an independent Wrangler instance. Playwright routes WebSocket
 * traffic for each feature to its assigned shard via the Vite proxy, so no
 * single Wrangler is overloaded with concurrent connections.
 *
 * Rules for grouping:
 * - Timer-sensitive tests (scheduled, heartbeat, hibernation) share one shard
 *   so their alarms don't compete with connection-heavy tests on the same process.
 * - Related features share a shard (e.g. all replay variants, all channel tests)
 *   so their Durable Object storage stays co-located.
 * - The remaining fast/small tests fill a shard of their own.
 *
 * To add a new route: add its name to a shard's routes array. The Vite proxy
 * and Playwright webServer config are both derived from this list.
 */

export interface Shard {
  readonly port: number;
  readonly routes: readonly string[];
}

export const SHARDS: Shard[] = [
  // Timer-sensitive: isolated so scheduled alarms and idle timeouts
  // don't starve each other when running in parallel.
  { port: 8787, routes: ['scheduled', 'heartbeat', 'hibernation'] },

  // Replay variants: share a shard because they exercise the same
  // Durable Object migration chain (ReplayServer family).
  { port: 8788, routes: ['replay', 'replay-custom', 'replay-snapshot'] },

  // Channel features: static channels, dynamic channels, membership API.
  { port: 8789, routes: ['channel-static', 'channel-dynamic', 'ctx-channels'] },

  // Connection context helpers: send pipeline, tags, meta, quality.
  { port: 8790, routes: ['ctx-send', 'ctx-tags', 'ctx-meta', 'ctx-quality'] },

  // Storage-heavy: SQL, KV, and the full Drizzle-backed module suite.
  { port: 8791, routes: ['ctx-sql', 'ctx-kv', 'modules'] },

  // Streams: basic delivery, broadcast fan-out, and nudge cadence.
  { port: 8792, routes: ['stream-basic', 'stream-broadcast', 'stream-nudges'] },

  // Protocol layer: lifecycle hooks, namespace scoping, intercepts, requests.
  // reject-http is the HTTP-branch of the upgrade-rejection test (same DO family).
  { port: 8793, routes: ['lifecycle-hooks', 'namespace', 'intercept', 'request', 'reject-http'] },

  // Fast / small: everything else runs here.
  {
    port: 8794,
    routes: [
      'ack',
      'binary',
      'incoming',
      'dedup',
      'sequence',
      'protocol-pings',
      'errors-factory',
      'errors-control-flow',
    ],
  },
];
