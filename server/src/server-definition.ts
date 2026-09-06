/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import type { TranslatorFactory } from '~/translation/translator.ts';

/**
 * The client-facing contract for a server — described from the **client's**
 * point of view.
 *
 * Each field is a record mapping event names to payload types (or richer
 * shapes for requests and streams). `InferClient<typeof myHandler>` reads this
 * to produce the typed client SDK. Adapters (server-cloudflare, server-bun,
 * etc.) also consume it so the handler and its adapter agree on one contract.
 *
 * **The naming is client-oriented, which flips against how you author the server.**
 * The table below is the one thing most readers get wrong:
 *
 * | Server authoring            | ServerContract field | Meaning for the client    |
 * | --------------------------- | -------------------- | ------------------------- |
 * | `emits({ 'msg': … })`       | `incoming`           | events the client receives|
 * | `base.on('msg', …)`         | `outgoing`           | events the client sends   |
 * | `base.request('r', …)`      | `clientRequests`     | req/response pairs        |
 * | `base.stream('s', …)`       | `streams`            | server-sent streams       |
 * | `base.resumableStream('s', …)` | `streams`         | server-sent streams       |
 * | `base.recordedStream('s', …)`  | `streams`         | server-sent streams       |
 * | `errors([...])`             | `errors`             | typed server errors       |
 * | `base.channel('x', …)`      | `channels`           | per-channel sub-contracts |
 *
 * `resumableStream` and `recordedStream` collapse into the same client
 * `streams` slot as plain `stream` — the durability mechanism is a server
 * concern and does not change the client's wire surface.
 *
 * @example
 * ```ts
 * import { define, emits, t } from '@wskit/server';
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [emits({ message: Message })],
 * });
 * const handleSend = base.on('send', { input: Send, run() {} });
 * const chat = base.assemble({ handlers: [handleSend] });
 *
 * type ChatClient = InferClient<typeof chat>;
 * // ChatClient.incoming.message   ← server-sent events
 * // ChatClient.outgoing.send      ← client-sent events
 * ```
 */
export interface ServerContract {
  /** Events the **client** receives — declared on the server with `emits({...})`. */
  readonly incoming: Record<string, any>;

  /** Events the **client** sends — declared on the server with `base.on(...)`. */
  readonly outgoing: Record<string, any>;

  /** Request/response pairs the client can invoke (declared with `base.request(...)`). */
  readonly clientRequests: Record<string, any>;

  /**
   * Server→client request/response pairs the client answers (declared with
   * `serverRequests({...})`). From the client's perspective these are the requests the
   * server asks it, answered via `socket.onRequest(...)`.
   */
  readonly serverRequests?: Record<string, any>;

  /**
   * Server-sent streams the client subscribes to. From the client's
   * perspective every server-pushed stream lives here regardless of
   * whether the server declared it with `stream(...)`, `resumableStream(...)`,
   * or `recordedStream(...)` — the durability mechanism is a server-side
   * concern.
   */
  readonly streams: Record<string, any>;

  /** Named, typed server errors the client can catch. */
  readonly errors: Record<string, any>;

  /** Per-channel sub-contracts. Each entry mirrors this shape for one channel. */
  readonly channels: Record<string, any>;

  /**
   * Per-plugin contract slices. Each carries the plugin's scoped contract and
   * `api` type. The contract feeds `InferClient`, which folds every plugin event
   * into the top-level client maps under its `__<id>::` wire name; the `api`
   * feeds the server ctx's `ctx.plugin(id)`.
   */
  readonly plugins?: Record<string, any>;
}

/**
 * The finalized blueprint for a WSKit server.
 *
 * You get a `ServerDefinition` by calling `base.assemble(...)` with your
 * handlers. It is an immutable, frozen object that holds all registered
 * primitives plus the contract type that `InferClient` uses to generate the
 * client-side API.
 *
 * Pass a `ServerDefinition` directly to your platform adapter:
 *
 * ```typescript
 * // Cloudflare
 * export const ChatRoom = server(chat)
 *
 * // Bun
 * server(chat, { port: 3000 })
 * ```
 *
 * @template TPrimitives - The frozen tuple of all registered primitives.
 * @template TContract - The client contract carried along with the built server.
 * @template TScopedCtx - The `ctx` type a scoped handler's own handlers receive.
 * @template TApi - The return type of the handler's `api` factory (the per-connection
 *   surface a plugin exposes via `ctx.plugin(id)`). `unknown` when no `api` is given.
 */
export interface ServerDefinition<
  TPrimitives extends readonly Primitive[] = readonly Primitive[],
  TContract extends ServerContract = ServerContract,
  TScopedCtx = unknown,
  TApi = unknown,
> {
  readonly __wskit: 'server';
  readonly primitives: TPrimitives;
  /**
   * Type-only field — never set at runtime.
   *
   * A scoped handler (`define({ scope: 'plugin' })`) brands its assembled
   * definition with the `ctx` type its own handlers receive. `plugin(...)`
   * reads this to type the `api` callback's `ctx` to the plugin's own scoped
   * surface and to carry its environment requirement to the host. Absent
   * (`unknown`) on app servers.
   */
  readonly __scopedCtx?: TScopedCtx;
  /**
   * Type-only field — never set at runtime.
   *
   * A handler assembled with an `api` factory brands its definition with that
   * factory's return type. `plugin(...)` reads this to type `ctx.plugin(id)`.
   * Absent (`unknown`) when no `api` was given.
   */
  readonly __api?: TApi;
  /** Runtime feature flags copied from the contract config for compile-time validation. */
  readonly __features?: ReadonlySet<string>;
  /** The per-user connection cap from `define({ users: {...} })`, enforced on accept. */
  readonly __usersPolicy?: {
    readonly maxConnections?: number;
    readonly onExceed: 'replace' | 'reject';
  };
  /** One optional foreign-wire translator factory, created once per connection. */
  readonly __translate?: TranslatorFactory;
  /**
   * Type-only field — never set at runtime.
   *
   * This is how the built server keeps its contract attached for tools like
   * `InferClient<typeof myServer>`. The `?` keeps it out of normal object
   * shapes and discourages runtime use.
   */
  readonly __contract?: TContract;
}

/**
 * The `api` type a handler was assembled with, or `unknown` when it had none.
 *
 * Adapters read this off the handler they are given so the service they return
 * carries the app's own admin methods — `server(handler)` on Cloudflare uses it
 * to type what `stub.admin()` resolves to.
 */
export type ApiOf<TDefinition> =
  TDefinition extends ServerDefinition<any, any, any, infer TApi> ? TApi : unknown;

/**
 * The per-connection metadata type a handler's `upgrade(...)` returns, read off
 * the ctx the definition is branded with.
 *
 * Adapters that carry connection snapshots across a serializing boundary need
 * the concrete type: a `Record<string, unknown>` fallback is not something
 * Cloudflare's RPC types accept as sendable. A handler with no `upgrade` hook
 * has no metadata type to read, so it lands on the empty fallback rather than
 * `unknown` — which would fail the same sendability check.
 */
export type MetaOf<TDefinition> =
  TDefinition extends ServerDefinition<any, any, infer TCtx, any>
    ? TCtx extends { meta: infer TMeta }
      ? unknown extends TMeta
        ? Record<string, never>
        : TMeta
      : Record<string, never>
    : Record<string, never>;
