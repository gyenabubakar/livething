/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Derive the typed `ctx` shape from a `Contract`.
 *
 * Every feature-gated method (`ack`, `sendReplay`, `sendBinary`, `broadcastBinary`,
 * `channel.sendReplay`) is always present on the type. At runtime, calling one
 * of these methods when the contract did not enable the matching feature
 * throws a clear error. Where the misuse is statically detectable from the
 * contract — e.g. registering an `onBinary` handler without `binary: true` —
 * `implement(...).build()` rejects it at boot.
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

/**
 * Typed tag groups. Group names are strictly the ones declared on the
 * contract — passing an undeclared name is a type error and a runtime throw.
 */
export interface TagsApi<TEphemeral extends string = never, TPersistent extends string = never> {
  ephemeral(group: TEphemeral): GroupHandle;
  persistent(group: TPersistent): GroupHandle;
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
  cancelScheduled<I extends keyof TScheduled & string>(
    taskId: I,
    filter?: Record<string, unknown>,
  ): { cancelledRunIds: string[]; taskExists: boolean };
}

// ---------------------------------------------------------------------------
// Top-level Ctx derivation
// ---------------------------------------------------------------------------

/**
 * The `ctx` object passed to handlers registered via
 * `implement(contract).on(...)`. Every method is always on the type. Calling
 * a feature method when the contract did not enable that feature throws at
 * runtime with a clear message.
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

  // Always-on feature surface. Runtime throws if the feature was not enabled.
  ack(): void;
  sendReplay(
    event: keyof C['outgoing'] & string,
    payload: unknown,
    wire: { seq: number; messageId: string; channel?: string; channelScope?: string | null },
  ): void;
  sendBinary(data: ArrayBuffer | ArrayBufferView): boolean;
  broadcastBinary(data: ArrayBuffer | ArrayBufferView, options?: { excludeSelf?: boolean }): void;
} & TypedSendApi<C['outgoing']> &
  ScheduleApi<C['scheduled']> & {
    readonly channels: keyof C['channels'] extends never
      ? ChannelsManager<string, string, Record<string, Record<string, unknown>>, C['meta']>
      : TypedChannelsManager<C['channels'], C['meta']>;
    readonly tags: TagsApi<
      C['tagGroups']['ephemeral'] extends string ? C['tagGroups']['ephemeral'] : never,
      C['tagGroups']['persistent'] extends string ? C['tagGroups']['persistent'] : never
    >;
  };

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
    sendReplay(
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
