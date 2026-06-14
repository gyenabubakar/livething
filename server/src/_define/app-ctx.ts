/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ConnectionInfo, ConnectionRef, KVProvider, Logger, SQLProvider } from '~/context.ts';
import type { LocalKey } from '~/local-key/local-key.ts';
import type { SlotOr } from './capability.ts';

/**
 * The `ctx` object every connection-scoped handler receives — the handlers you
 * register with `base.on(...)` and the connect/disconnect lifecycle hooks.
 *
 * `send` and `broadcast` are typed against the server's `emits(...)` events, so
 * a typo or wrong payload is a compile error. The identity, metadata, storage,
 * and logging surfaces are always present.
 *
 * @template TSlots The merged contract slots — drives the typed `send`/`broadcast`.
 * @template TEnv   The platform env bindings, declared by `env: t<Env>()`.
 * @template TMeta  The per-connection metadata returned from `upgrade(...)`.
 */
export type AppCtx<TSlots, TEnv, TMeta> = {
  /** Unique id of this connection. Stable for the lifetime of the socket. */
  readonly id: string;
  /** The identity string returned from `upgrade(...)`. Stable until disconnect. */
  readonly identity: string;
  /** A reference handle to this connection — pass it to `kick`, `subscribe`, and the like. */
  readonly self: ConnectionRef;
  /** The metadata returned from `upgrade(...)`, typed from its return value. */
  readonly meta: TMeta;
  /** The platform env bindings (for example Cloudflare Workers `Env`). */
  readonly env: TEnv;
  /** The raw platform handle (for example a Durable Object state). Untyped by default. */
  readonly platform: unknown;

  /** Bytes currently buffered on the socket. A rising value signals a slow client. */
  readonly bufferedAmount: number;
  /** Last measured round-trip latency in ms, or `null` if not known yet. */
  readonly latency: number | null;
  /** Coarse health bucket from latency. `null` when hibernation is on (no server ping). */
  readonly quality: 'excellent' | 'good' | 'degraded' | 'poor' | null;
  /** The socket close code — set only inside the disconnect hook. */
  readonly closeCode?: number;
  /** The socket close reason — set only inside the disconnect hook. */
  readonly closeReason?: string;

  /** Number of connections currently open on this server instance. */
  readonly connectionCount: number;

  /** Send an event to one other connection by id. Returns false if it is not here. */
  sendToConnection(connectionId: string, event: string, payload: unknown): boolean;
  /** Close this connection. */
  close(code?: number, reason?: string): void;
  /** Snapshot of every connection currently open on this server instance. */
  getConnections(): ConnectionInfo<TMeta>[];

  /** Adapter-provided SQL surface. Throws if the adapter has no storage. */
  readonly sql: SQLProvider;
  /** Adapter-provided key/value surface. Throws if the adapter has no storage. */
  readonly kv: KVProvider;
  /** Engine logger — `info` / `warn` / `error`. */
  readonly log: Logger;
  /** Keep a promise running past the end of the handler (for example Cloudflare `waitUntil`). */
  waitUntil(promise: Promise<unknown>): void;
  /** Set the next alarm on the adapter's timer surface (unix ms). */
  setAlarm(time: number): void;

  /**
   * Queue a scheduled task to run once at `time` (unix ms). The body bound with
   * `base.scheduled(taskId, ...)` runs then, receiving `data`. Only tasks
   * declared by the `scheduled(...)` capability are accepted.
   */
  schedule<TTaskId extends keyof Scheduled<TSlots> & string>(
    taskId: TTaskId,
    options: Scheduled<TSlots>[TTaskId] extends undefined
      ? { time: number; data?: undefined }
      : { time: number; data: Scheduled<TSlots>[TTaskId] },
  ): void;
  /**
   * Cancel pending runs of a scheduled task. With no filter it cancels every
   * pending run; with a filter it cancels runs whose `data` matches its keys.
   */
  cancelScheduled<TTaskId extends keyof Scheduled<TSlots> & string>(
    taskId: TTaskId,
    filter?: Record<string, unknown>,
  ): void;

  /**
   * Store a typed value for the current message dispatch. Every downstream
   * intercept and the final handler sharing this dispatch can read it back with
   * `inject`. Each dispatch starts with an empty store.
   */
  provide<T>(key: LocalKey<T>, value: T): void;
  /**
   * Read a value stored earlier in this dispatch with `provide`. Returns
   * `undefined` when nothing was stored for the key.
   */
  inject<T>(key: LocalKey<T>): T | undefined;

  /** Send an event to the current connection. Returns false if the socket can't accept it. */
  send<E extends keyof Outgoing<TSlots> & string>(event: E, payload: Outgoing<TSlots>[E]): boolean;
  /**
   * Send an event to every other connection on this server. The calling
   * connection is excluded by default; pass `excludeSelf: false` to include it.
   */
  broadcast<E extends keyof Outgoing<TSlots> & string>(
    event: E,
    payload: Outgoing<TSlots>[E],
    options?: { excludeSelf?: boolean },
  ): void;
};

/** The server→client events, read off the merged contract slots. */
type Outgoing<TSlots> = SlotOr<TSlots, 'outgoing'>;

/** The scheduled-task map (task id → payload type), read off the merged contract slots. */
type Scheduled<TSlots> = SlotOr<TSlots, 'scheduled'>;
