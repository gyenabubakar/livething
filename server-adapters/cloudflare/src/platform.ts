/**
 * The type of `ctx.platform` in a handler that runs on Cloudflare. `ctx.platform`
 * has the type `unknown` in the core API, so cast it to `Platform<Env>`.
 *
 * Use the LiveThing APIs (`ctx.sql`, `ctx.kv`, `ctx.schedule`, `ctx.connections`)
 * first. Use `ctx.platform` only for a Cloudflare feature that LiveThing does not wrap.
 *
 * - `env`: your Worker bindings, such as KV namespaces and secrets.
 * - `ctx.storage`: the raw Durable Object storage.
 * - `ctx.blockConcurrencyWhile()`: the Durable Object state method.
 * - `ctx.waitUntil()`: rarely needed. With a `compatibility_date` of `2026-10-01`
 *   or later, or the `durable_object_io_tasks_prevent_eviction` flag, a promise
 *   passed here keeps the object in memory until it settles (up to 15 minutes).
 *   Without either, the object can be removed while it is pending. It does not
 *   change when a request completes.
 * - `ctx.getWebSockets()`: the sockets accepted through the hibernation API, so
 *   it returns sockets only when hibernation is on. LiveThing does not add tags
 *   to Cloudflare's per-socket tag list, so `getWebSockets(tag)` returns an
 *   empty list. Use `ctx.connections` or a tag's `connections()` to find
 *   connections.
 *
 * @example
 * ```ts
 * const platform = ctx.platform as Platform<Env>;
 * const topic = await platform.env.ROOM_TOPICS.get(input.room);
 * ```
 */
export interface Platform<Env = unknown> {
  ctx: {
    blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T>;
    getWebSockets(tag?: string): WebSocket[];
    waitUntil?(promise: Promise<unknown>): void;
    storage: DurableObjectStorage;
  };
  env: Env;
}

/**
 * Build the `ctx.platform` object from Cloudflare's Durable Object runtime.
 */
export function createPlatform<Env>(state: DurableObjectState, env: Env): Platform<Env> {
  return {
    ctx: {
      blockConcurrencyWhile: state.blockConcurrencyWhile.bind(state),
      getWebSockets: state.getWebSockets.bind(state),
      waitUntil: state.waitUntil?.bind(state),
      storage: state.storage,
    },
    env,
  };
}
