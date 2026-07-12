import type { WSKitError } from '@wskit/core';
import type { ReadableStore } from '~/internal/store.ts';
import type { Messaging } from '~/messaging.ts';
import type { CloseEvent } from '~/socket/socket.ts';
import type { ConnectionState, ErrorsOf, IncomingOf, OutgoingOf, SocketContract } from '~/types.ts';

/**
 * The connection methods every socket has, no matter the contract. The typed
 * `on()` / `send()` come from `Messaging` and are added in by `Socket` below.
 */
export interface SocketConnection {
  /** Open the connection. Safe to call more than once. */
  connect(): void;
  /** Close on purpose. Defaults to code 1000 and an empty reason. */
  disconnect(code?: number, reason?: string): void;

  /**
   * The connection state as a reactive store. Read it now with `state.get()`
   * (`'closed'` | `'connecting'` | `'open'` | `'reconnecting'`), or watch it with
   * `state.subscribe(listener)` — the listener runs with the new state on every
   * change and returns an unsubscribe. This is the standard store shape, so it
   * drops into any framework (see [Framework Hooks](/recipes/framework-hooks/overview)).
   */
  readonly state: ReadableStore<ConnectionState>;

  /** Runs on every open (first connect and reconnects). */
  onOpen(callback: () => void): () => void;
  /** Runs only on reconnects. */
  onReconnect(callback: () => void): () => void;
  /** Runs once when reconnection gives up. */
  onReconnectFailed(callback: () => void): () => void;
  /** Runs on every close. */
  onClose(callback: (event: CloseEvent) => void): () => void;

  /** Turn console logging on or off at runtime. */
  setDebug(enabled: boolean): void;

  /** The subprotocol the server picked, or `null`. */
  readonly protocol: string | null;
  /** The native WebSocket, or `null` when not connected. */
  readonly ws: WebSocket | null;
}

/**
 * Carries the contract on the socket type in a covariant, inferable position so
 * helpers like `inject()` can recover it from the real (intersection) socket the
 * builder returns. It's phantom — never present at runtime — and optional so
 * hand-built socket shapes still satisfy `Socket`.
 */
export interface SocketContractBrand<TContract extends SocketContract> {
  readonly _socketContract?: TContract;
}

/**
 * Every error the contract declares — the framework's built-in errors plus your
 * server's and any plugins' — as a discriminated union of `WSKitError`, each typed
 * to its own code and detail. `onError` hands you this, so `switch (err.code)`
 * types `err.detail` per case.
 */
export type ContractError<TContract extends SocketContract> = {
  [TCode in keyof ErrorsOf<TContract> & string]: WSKitError<TCode, ErrorsOf<TContract>[TCode]>;
}[keyof ErrorsOf<TContract> & string];

/**
 * The socket type you work with: the connection methods plus typed `on()` and
 * `send()` for your contract. Primitives add their own methods on top through
 * `client()`.
 */
export type Socket<TContract extends SocketContract = SocketContract> = SocketConnection &
  Messaging<IncomingOf<TContract> & object, OutgoingOf<TContract> & object> &
  SocketContractBrand<TContract> & {
    /**
     * Runs on a server error that no request or stream claimed, typed to the
     * contract's errors. Narrow with `err instanceof WSKitError` — the other case
     * is a transport-level `Event` — then `switch (err.code)` for a typed
     * `err.detail`. A code the contract doesn't declare is still possible at
     * runtime (a server the client's types don't match), so keep a `default`.
     */
    onError(callback: (error: ContractError<TContract> | Event) => void): () => void;
  };
