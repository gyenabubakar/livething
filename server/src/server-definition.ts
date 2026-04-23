/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';

/**
 * The client-facing contract for a server — described from the **client's**
 * point of view.
 *
 * Each field is a record mapping event names to payload types (or richer
 * shapes for requests and streams). `InferClient<typeof myServer>` reads this
 * to produce the typed client SDK. Adapters (server-cloudflare, server-bun,
 * etc.) also consume it so the handler and its adapter agree on one contract.
 *
 * **The naming is client-oriented, which is the opposite of what the server
 * builder uses.** The table below is the one thing most users get wrong:
 *
 * | Server builder call | ServerContract field | Meaning for the client    |
 * | ------------------- | -------------------- | ------------------------- |
 * | `.outgoing(Msg)`    | `incoming`           | events the client receives|
 * | `.incoming(Msg)`    | `outgoing`           | events the client sends   |
 * | `.request(Req)`     | `requests`           | req/response pairs        |
 * | `.stream(Stm)`      | `streams`            | server-sent streams       |
 * | `.errors(...)`      | `errors`             | typed server errors       |
 * | `.channel('x', …)`  | `channels`           | per-channel sub-contracts |
 * | `.namespace('y', …)`| `namespaces`         | per-namespace sub-contracts|
 *
 * @example
 * ```ts
 * // Server side
 * const chat = server('chat').outgoing(Message).incoming(Send).build();
 *
 * // Client side — ctx comes from the server perspective, client sees the flip
 * type ChatClient = InferClient<typeof chat>;
 * // ChatClient.incoming.message   ← server-sent events
 * // ChatClient.outgoing.send      ← client-sent events
 * ```
 */
export interface ServerContract {
  /** Events the **client** receives — declared on the server with `.outgoing(...)`. */
  readonly incoming: Record<string, any>;

  /** Events the **client** sends — declared on the server with `.incoming(...)`. */
  readonly outgoing: Record<string, any>;

  /** Request/response pairs the client can invoke (`.request(...)` on the server). */
  readonly requests: Record<string, any>;

  /** Server-sent streams the client subscribes to (`.stream(...)` on the server). */
  readonly streams: Record<string, any>;

  /** Named, typed server errors the client can catch. */
  readonly errors: Record<string, any>;

  /** Per-channel sub-contracts. Each entry mirrors this shape for one channel. */
  readonly channels: Record<string, any>;

  /** Per-namespace sub-contracts. Each entry mirrors this shape for one namespace. */
  readonly namespaces: Record<string, any>;
}

/**
 * The finalized blueprint for a wskit server.
 *
 * You get a `ServerDefinition` by calling `.build()` at the end of a
 * `server(name)` builder chain. It is an immutable, frozen object that holds
 * all registered primitives plus the contract type that `InferClient` uses to
 * generate the client-side API.
 *
 * Pass a `ServerDefinition` directly to your platform adapter:
 *
 * ```typescript
 * // Cloudflare
 * export const ChatRoom = serve(chat)
 *
 * // Bun
 * serve(chat, { port: 3000 })
 * ```
 *
 * @template TPrimitives - The frozen tuple of all registered primitives.
 * @template TContract - The client contract carried along with the built server.
 */
export interface ServerDefinition<
  TPrimitives extends readonly Primitive[] = readonly Primitive[],
  TContract extends ServerContract = ServerContract,
> {
  readonly __wskit: 'server';
  readonly primitives: TPrimitives;
  /**
   * Type-only field — never set at runtime.
   *
   * This is how the built server keeps its contract attached for tools like
   * `InferClient<typeof myServer>`. The `?` keeps it out of normal object
   * shapes and discourages runtime use.
   */
  readonly __contract?: TContract;
}
