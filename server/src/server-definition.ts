/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import type { TranslatorFactory } from '~/translation/translator.ts';

/**
 * The contract of a server, described from the **server's** point of view.
 *
 * Each field is a record mapping event names to payload types (or richer
 * shapes for requests and streams). `InferClient<typeof myDefinition>` reads this
 * and flips `incoming` and `outgoing` to produce the typed client contract.
 * Adapters (server-cloudflare, server-bun, etc.) also consume it so the server
 * definition and its adapter agree on one contract.
 *
 * | Server authoring            | ServerContract field | Client contract field     |
 * | --------------------------- | -------------------- | ------------------------- |
 * | `emits({ 'msg': … })`       | `outgoing`           | `incoming`                |
 * | `base.on('msg', …)`         | `incoming`           | `outgoing`                |
 * | `base.request('r', …)`      | `clientRequests`     | `clientRequests`          |
 * | `serverRequests({...})`     | `serverRequests`     | `serverRequests`          |
 * | `base.stream('s', …)`       | `streams`            | `streams`                 |
 * | `base.cursorStream('s', …)` | `streams`         | `streams`                 |
 * | `base.recordedStream('s', …)`  | `streams`         | `streams`                 |
 * | `errors([...])`             | `errors`             | `errors`                  |
 * | `base.channel('x', …)`      | `channels`           | `channels` (each flipped) |
 *
 * `cursorStream` and `recordedStream` collapse into the same client
 * `streams` slot as plain `stream` — the durability mechanism is a server
 * concern and does not change the client's wire surface.
 *
 * For routed handlers, a row exists only when the value returned by the
 * matching `base.*(...)` call is included in `base.assemble({ handlers: [...] })`.
 *
 * @example
 * ```ts
 * import { server, emits, t } from '@livething/server';
 *
 * const base = server({
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
  /** Events the server receives — declared with `base.on(...)`. The client sends these. */
  readonly incoming: Record<string, any>;

  /** Events the server sends — declared with `emits({...})`. The client receives these. */
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
   * whether the server declared it with `stream(...)`, `cursorStream(...)`,
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
 * The finalized blueprint for a LiveThing server.
 *
 * You get a `ServerDefinition` by calling `base.assemble(...)` with your
 * handlers. It is an immutable, frozen object that holds all assembled
 * primitives plus the contract type that `InferClient` uses to generate the
 * client-side API.
 *
 * Pass a `ServerDefinition` directly to your platform adapter:
 *
 * ```typescript
 * // Cloudflare
 * export class ChatRoom extends bind(chat) {}
 *
 * // Bun
 * server(chat, { port: 3000 })
 * ```
 *
 * @template TPrimitives - The frozen tuple of all assembled primitives.
 * @template TContract - The client contract carried along with the built server.
 * @template TScopedCtx - The `ctx` type a scoped server definition's own handlers receive.
 * @template TApi - The return type of the server definition's `api` factory (the per-connection
 *   surface a plugin exposes via `ctx.plugin(id)`). `unknown` when no `api` is given.
 */
export interface ServerDefinition<
  TPrimitives extends readonly Primitive[] = readonly Primitive[],
  TContract extends ServerContract = ServerContract,
  TScopedCtx = unknown,
  TApi = unknown,
> {
  readonly __livething: 'server';
  /** Id of the `base` that assembled this definition. Read by the `context.*` accessors. @internal */
  readonly __baseId?: symbol;
  readonly primitives: TPrimitives;
  /**
   * Type-only field — never set at runtime.
   *
   * A scoped server definition (`server({ scope: 'plugin' })`) brands its assembled
   * definition with the `ctx` type its own handlers receive. `plugin(...)`
   * reads this to type the `api` callback's `ctx` to the plugin's own scoped
   * surface. Absent
   * (`unknown`) on app servers.
   */
  readonly __scopedCtx?: TScopedCtx;
  /**
   * Type-only field — never set at runtime.
   *
   * A server definition assembled with an `api` factory brands itself with that
   * factory's return type. `plugin(...)` reads this to type `ctx.plugin(id)`.
   * Absent (`unknown`) when no `api` was given.
   */
  readonly __api?: TApi;
  /** Runtime feature flags copied from the contract config for compile-time validation. */
  readonly __features?: ReadonlySet<string>;
  /** The per-user connection cap from `server({ users: {...} })`, enforced on accept. */
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
 * The `api` type a server definition was assembled with, or `unknown` when it had none.
 *
 * Adapters read this off the server definition they are given so the service they return
 * carries the app's own admin methods — `bind(definition)` on Cloudflare uses it
 * to type what `stub.admin()` resolves to.
 */
export type ApiOf<TDefinition> =
  TDefinition extends ServerDefinition<any, any, any, infer TApi> ? TApi : unknown;

/**
 * The per-connection metadata type a server definition's `upgrade(...)` returns, read off
 * the ctx the definition is branded with.
 *
 * Adapters that carry connection snapshots across a serializing boundary need
 * the concrete type: a `Record<string, unknown>` fallback is not something
 * Cloudflare's RPC types accept as sendable. A server definition with no `upgrade` hook
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
