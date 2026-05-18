/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Derive the typed `ctx` shape from a `Contract`. The result is intersected
 * with the broad `ConnectionContext` superset so unused fields are still
 * available at runtime — but the typed slots (`send`, `broadcast`, `tags`,
 * `channels.get`, `schedule`, `meta`) are narrowed from the contract.
 */

import type {
  ChannelHandle,
  ChannelsManager,
  ConnectionInfo,
  ConnectionRef,
  KVProvider,
  Logger,
  SQLProvider,
  TagRef,
} from '~/context.ts';
import type { Contract } from './contract-types.ts';

// ---------------------------------------------------------------------------
// Typed messaging APIs
// ---------------------------------------------------------------------------

interface TypedSendApi<TOutgoing> {
  send<E extends keyof TOutgoing & string>(event: E, payload: TOutgoing[E]): boolean;
  broadcast<E extends keyof TOutgoing & string>(
    event: E,
    payload: TOutgoing[E],
    options?: { excludeSelf?: boolean },
  ): void;
}

// ---------------------------------------------------------------------------
// Typed tags API
// ---------------------------------------------------------------------------

/**
 * Address for every connection holding any key under one group. Built via
 * `ctx.tags.ephemeral(group)` / `ctx.tags.persistent(group)`.
 */
export interface GroupHandle {
  readonly __wskit: 'group-handle';
  readonly kind: 'ephemeral' | 'persistent';
  readonly group: string;
  /** Add a key for the current connection under this group. */
  add(key: string): void;
  /** Remove a key from the current connection under this group. */
  remove(key: string): void;
  /** Return a handle to every connection holding a specific key under this group. */
  ref(key: string): TagRefHandle;
}

export interface TagRefHandle extends TagRef {
  /** Send an event to every connection holding this tag. */
  send(event: string, payload: unknown): void;
  /** Snapshot of every connection currently holding this tag. */
  connections(): readonly ConnectionInfo[];
  /** Count of connections currently holding this tag. */
  count(): number;
}

// Use the `& {}` trick so explicit literal types in autocomplete still suggest
// declared group names while still accepting any runtime string.
export interface TagsApi<TEphemeral = string, TPersistent = string> {
  ephemeral(group: TEphemeral | (string & {})): GroupHandle;
  persistent(group: TPersistent | (string & {})): GroupHandle;
  /** Snapshot of every tag currently attached to this connection. */
  list(): readonly { kind: 'ephemeral' | 'persistent'; group: string; key: string }[];
}

// ---------------------------------------------------------------------------
// Typed channels manager
// ---------------------------------------------------------------------------

type ChannelOutgoing<C> = C extends { outgoing: infer O }
  ? O extends Record<string, any>
    ? O
    : {}
  : {};

type TypedChannelsManager<TChannels, Meta> = {
  get<K extends keyof TChannels & string>(
    name: K,
  ): ChannelHandle<ChannelOutgoing<TChannels[K]>, Meta>;
  get<K extends keyof TChannels & string>(
    family: K,
    name: string,
  ): ChannelHandle<ChannelOutgoing<TChannels[K]>, Meta>;
};

// ---------------------------------------------------------------------------
// Scheduled api
// ---------------------------------------------------------------------------

interface ScheduleApi<TScheduled> {
  schedule<I extends keyof TScheduled & string>(
    taskId: I,
    options: TScheduled[I] extends undefined | unknown
      ? { time: number; data?: TScheduled[I] }
      : { time: number; data: TScheduled[I] },
  ): void;
  // Accept arbitrary string task IDs at runtime (e.g. module-owned tasks
  // prefixed with `__`). The contract-keyed overload above gives precise
  // typing for declared tasks.
  schedule(taskId: string, options: { time: number; data?: unknown }): void;
  cancelScheduled<I extends keyof TScheduled & string>(
    taskId: I,
    filter?: Record<string, unknown>,
  ): { cancelledRunIds: string[]; taskExists: boolean };
  cancelScheduled(
    taskId: string,
    filter?: Record<string, unknown>,
  ): { cancelledRunIds: string[]; taskExists: boolean };
}

// ---------------------------------------------------------------------------
// Top-level Ctx derivation
// ---------------------------------------------------------------------------

type FeatureCtx<C extends Contract> = ('ack' extends C['features'] ? { ack(): void } : {}) &
  ('replay' extends C['features']
    ? {
        sendReplay(
          event: keyof C['outgoing'] & string,
          payload: unknown,
          wire: { seq: number; messageId: string; channel?: string; channelScope?: string | null },
        ): void;
      }
    : {}) &
  ('binary' extends C['features']
    ? {
        sendBinary(data: ArrayBuffer | ArrayBufferView): boolean;
        broadcastBinary(
          data: ArrayBuffer | ArrayBufferView,
          options?: { excludeSelf?: boolean },
        ): void;
      }
    : {});

/**
 * The `ctx` object passed to handlers registered via
 * `implement(contract).on(...)`. Derives every typed slot from the contract.
 */
export type Ctx<C extends Contract> = {
  readonly id: string;
  readonly identity: string;
  readonly self: ConnectionRef;
  readonly meta: C['meta'];
  readonly env: C['env'];
  readonly platform: unknown;

  readonly bufferedAmount: number;
  readonly latency: number | null;
  readonly quality: 'excellent' | 'good' | 'degraded' | 'poor';
  readonly closeCode?: number;
  readonly closeReason?: string;

  readonly connectionCount: number;

  sendToConnection(connectionId: string, event: string, payload: unknown): boolean;
  close(code?: number, reason?: string): void;
  getConnections(): ConnectionInfo<C['meta']>[];

  readonly sql: SQLProvider;
  readonly kv: KVProvider;
  readonly log: Logger;
  waitUntil(promise: Promise<unknown>): void;
  setAlarm(time: number): void;
} & TypedSendApi<C['outgoing']> &
  ScheduleApi<C['scheduled']> & {
    readonly channels: keyof C['channels'] extends never
      ? ChannelsManager<string, string, Record<string, Record<string, unknown>>, C['meta']>
      : TypedChannelsManager<C['channels'], C['meta']>;
    readonly tags: TagsApi<C['tagGroups']['ephemeral'], C['tagGroups']['persistent']>;
  } & FeatureCtx<C>;

// ---------------------------------------------------------------------------
// Channel-scoped ctx
// ---------------------------------------------------------------------------

type ChannelOutgoingOf<T> = T extends { outgoing: infer O } ? O : Record<string, unknown>;

export type ChannelCtx<TChannelContract, C extends Contract> = Omit<Ctx<C>, 'channel'> & {
  readonly channel: {
    readonly name: string;
    readonly scope: string | null;
    send<E extends keyof ChannelOutgoingOf<TChannelContract> & string>(
      event: E,
      payload: ChannelOutgoingOf<TChannelContract>[E],
    ): boolean;
    broadcast<E extends keyof ChannelOutgoingOf<TChannelContract> & string>(
      event: E,
      payload: ChannelOutgoingOf<TChannelContract>[E],
      options?: { excludeSelf?: boolean },
    ): void;
    members(): ConnectionInfo<C['meta']>[];
    subscribe(ref: ConnectionRef, payload?: unknown): Promise<void>;
    kick(target: ConnectionRef | TagRef | GroupHandle, reason: string): Promise<void>;
    removeMember(identity: string): Promise<void>;
    sendReplay?(
      event: keyof ChannelOutgoingOf<TChannelContract> & string,
      payload: unknown,
      wire: { seq: number; messageId: string; channel?: string; channelScope?: string | null },
    ): void;
  };
};

// ---------------------------------------------------------------------------
// Namespace-scoped ctx
// ---------------------------------------------------------------------------

export type NamespaceCtx<TNamespaceContract, C extends Contract> = Omit<Ctx<C>, 'namespace'> & {
  readonly namespace: {
    readonly name: string;
    send<E extends keyof ChannelOutgoingOf<TNamespaceContract> & string>(
      event: E,
      payload: ChannelOutgoingOf<TNamespaceContract>[E],
    ): boolean;
    broadcast<E extends keyof ChannelOutgoingOf<TNamespaceContract> & string>(
      event: E,
      payload: ChannelOutgoingOf<TNamespaceContract>[E],
      options?: { excludeSelf?: boolean },
    ): void;
  };
};
