/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';

/**
 * The full shape of the client-facing contract for a server.
 *
 * This describes every category of message that can flow between the server
 * and its clients. Each field is a record mapping event names to payload types
 * (or richer shapes for requests, streams, etc.).
 *
 * `InferClient` reads this to produce the typed client API. Adapters
 * (server-cloudflare, server-bun, etc.) also use it so your handler and your
 * platform adapter agree on the same contract.
 */
export interface ServerContract {
  /** Events the server sends to clients (`outgoing()` from the server perspective). */
  readonly incoming: Record<string, any>;

  /** Events clients send to the server (`incoming()` from the server perspective). */
  readonly outgoing: Record<string, any>;

  /** Request/response pairs initiated by the client. */
  readonly requests: Record<string, any>;

  /** Server-sent streams initiated by the client. */
  readonly streams: Record<string, any>;

  /** Named server errors that can be sent to the client. */
  readonly errors: Record<string, any>;

  /** Channel scopes registered on this server. */
  readonly channels: Record<string, any>;

  /** Namespace scopes registered on this server. */
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
