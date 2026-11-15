import type { LiveThingError } from '@livething/core';
import type { ReadableStore } from '~/internal/store.ts';
import type { Messaging } from '~/messaging.ts';
import type { CloseEvent } from '~/socket/socket.ts';
import type { TransportName } from '~/transports/transport.ts';
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
   * drops into any framework (see [Framework Hooks](/recipes/framework-hooks/react)).
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

  /**
   * Wait until the transport's send buffer is below 256 KiB. Call it between large sends,
   * so a loop does not queue more than the network can carry. It resolves at once when the
   * socket is not open, and stops waiting after about 50 seconds.
   */
  drain(): Promise<void>;

  /** Turn console logging on or off at runtime. */
  setDebug(enabled: boolean): void;

  /** The subprotocol the server picked, or `null`. */
  readonly protocol: string | null;
  /** The native WebSocket, or `null` when not connected or on another transport. */
  readonly ws: WebSocket | null;
  /**
   * The transport in use, as a reactive store: `'websocket'`, `'sse'` or a custom transport's
   * name, or `null` when not connected.
   */
  readonly transport: ReadableStore<TransportName | null>;
}

/**
 * Carries the contract on the socket type in a covariant, inferable position so
 * helpers like `inject()` can recover it from the real (intersection) socket the
 * builder returns. It's phantom — never present at runtime — and optional so
 * hand-built socket shapes still satisfy `Socket`.
 */
interface SocketContractBrand<TContract extends SocketContract> {
  readonly _socketContract?: TContract;
}

/**
 * Every error the contract's `errors` section declares, as a discriminated union
 * of `LiveThingError`, each typed to its own code and detail. Use it when a typed
 * contract error is needed in an API or helper; the runtime `onError` callback
 * is `unknown` because local code can throw any JavaScript value. A contract
 * from `InferClient` already folds in the framework's built-in errors alongside
 * your server's and any plugins'.
 */
export type ContractError<TContract extends SocketContract> = {
  [TCode in keyof ErrorsOf<TContract> & string]: LiveThingError<TCode, ErrorsOf<TContract>[TCode]>;
}[keyof ErrorsOf<TContract> & string];

type ContractErrorCode<TContract extends SocketContract> = keyof ErrorsOf<TContract> & string;

/**
 * The socket type you work with: the connection methods plus typed `on()` and
 * `send()` for your contract. Primitives add their own methods on top through
 * `client()`.
 */
export type Socket<TContract extends SocketContract = SocketContract> = SocketConnection &
  Messaging<IncomingOf<TContract> & object, OutgoingOf<TContract> & object> &
  SocketContractBrand<TContract> & {
    /** Runs on transport events and values thrown by handlers, primitives, or plugins. */
    onError(callback: (error: unknown) => void): () => void;

    /** Runs on any unclaimed server error, including codes added by a newer server. */
    onServerError(callback: (error: LiveThingError<string, unknown>) => void): () => void;
    /** Runs only when an unclaimed server error has this declared contract code. */
    onServerError<TCode extends ContractErrorCode<TContract>>(
      code: TCode,
      callback: (error: LiveThingError<TCode, ErrorsOf<TContract>[TCode]>) => void,
    ): () => void;
  };
