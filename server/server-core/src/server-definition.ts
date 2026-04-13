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
 * (server-cloudflare, server-bun, etc.) also read it at the type level to
 * ensure your handler and your platform adapter stay in sync.
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
 * all registered primitives and a phantom `__contract` type used by
 * `InferClient` to generate the client-side type.
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
 * @template TContract - The accumulated client contract, read by `InferClient`.
 */
export interface ServerDefinition<
  TPrimitives extends readonly Primitive[] = readonly Primitive[],
  TContract extends ServerContract = ServerContract,
> {
  readonly __wskit: 'server';
  readonly primitives: TPrimitives;
  /**
   * Phantom field — never set at runtime (`undefined` always).
   *
   * TypeScript reads `TContract` from here when you write
   * `InferClient<typeof myServer>`. The `?` keeps it out of object shapes and
   * prevents accidental runtime access.
   */
  readonly __contract?: TContract;
}
