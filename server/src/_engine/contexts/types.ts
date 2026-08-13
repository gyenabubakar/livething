import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as FeatureSlots from '~/_engine/runtime/feature-slots.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as WireRuntime from '~/_engine/runtime/wire.ts';
import type * as ChannelRuntime from '~/channel/runtime.ts';
import type * as PublicApi from '~/context.ts';
import type * as OutgoingRuntime from '~/outgoing/runtime.ts';
import type { ScheduledCancelResult } from '~/scheduled/types.ts';
import type { Validator } from '~/types.ts';

/**
 * Hidden channel markers attached to live connection contexts for engine-owned
 * helpers and primitive context extenders.
 */
export interface EngineChannelMeta {
  channelName?: string;
  /**
   * Family marker for the active channel: `null` for static channels, the
   * family key for dynamic channel families, `undefined` when no channel is
   * active.
   */
  channelFamily?: string | null;

  /**
   * Set on the ctx built for `check`/`commit`/`revalidate`. Those three are
   * written inside the same `base.channel(...)` config object as
   * `capabilities`, so TypeScript cannot yet resolve what that list adds to
   * `ctx.channel` — it has not finished reading the object it is still
   * type-checking. Channel-only context extenders (inbox, read receipts)
   * read this flag to skip attaching their member, matching that gap at
   * runtime too.
   */
  isSubscribeGate?: boolean;
}

/**
 * Shared capabilities needed to build init, task, shutdown, and connection
 * contexts from the engine state.
 */
export interface ContextCommonDeps {
  env: Record<string, unknown>;

  logger: PublicApi.Logger;

  platform: unknown;

  waitUntilImpl: (promise: Promise<unknown>) => void;

  /**
   * The engine's instance id, or `undefined` when running single-instance.
   * Read when building `ConnectionRef`s on `ConnectionInfo` or `ctx.connection`.
   */
  instanceId: string | undefined;

  getStorage(): PublicApi.StorageProvider;

  /** The engine's shared `sql` / `kv` view, built once and reused by every context. */
  getStorageView(): { sql: PublicApi.SQLProvider; kv: PublicApi.KVProvider };

  getTimers(): PublicApi.TimerProvider;

  scheduleTask(taskId: string, time: number, data: unknown): void;

  cancelScheduled(taskId: string, filter?: Record<string, unknown>): ScheduledCancelResult;

  broadcastToConnections(
    connections: readonly EngineRuntimeTypes.RuntimeConnection[],
    opts: OutgoingRuntime.BroadcastToConnectionsOptions,
  ): void;

  sendThroughPipeline(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: OutgoingRuntime.SendThroughPipelineOptions,
  ): boolean;

  broadcastToChannel(opts: OutgoingRuntime.BroadcastToChannelOptions): void;

  /**
   * Deliver a channel-scoped frame to the members a `to` recipient addresses,
   * returning the number of sockets reached. Backs `ctx.channel.send(..., { to })`
   * and the equivalent on any `ChannelHandle`.
   */
  sendToChannelRecipient(opts: {
    channelName: string;
    channelFamily: string | null;
    to: ChannelRuntime.ChannelRecipient;
    event: string;
    payload: unknown;
  }): number;

  getChannelMembers(
    channelName: string,
    channelFamily: string | null,
  ): PublicApi.ConnectionInfo<Record<string, unknown>>[];

  kickChannelMembers(opts: ChannelRuntime.KickChannelMembersOptions): Promise<void>;

  /**
   * Server-initiated channel subscribe. Invoked from `channelHandle.subscribe(ref)`.
   * Resolves to a no-op when the target connection is already a member.
   */
  subscribeConnectionAsServer(
    ref: PublicApi.ConnectionRef,
    opts: Omit<ChannelRuntime.SubscribeConnectionAsServerOptions, 'rejoining'>,
  ): Promise<void>;

  resolveChannel(
    target: string | { family: string; name: string },
  ):
    | { channelName: string; channelFamily: string | null; params: Record<string, string> }
    | undefined;

  sendReplay(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: WireRuntime.SendReplayOptions,
  ): void;

  sendProtocolMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: WireRuntime.SendProtocolMessageOptions,
  ): void;

  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;

  toConnectionInfo(
    connection: EngineRuntimeTypes.RuntimeConnection,
  ): PublicApi.ConnectionInfo<Record<string, unknown>>;

  contextExtenders?: readonly ((ctx: unknown) => Record<string, unknown>)[];
  /**
   * Whether at least one tag group was declared via the contract's `tagGroups`
   * config. When `false`, `ctx.tags` is omitted from every connection context.
   */
  usesTags: boolean;

  /**
   * Check whether a given `(kind, group)` is declared on this engine. The tag
   * runtime throws when a handler accesses an undeclared group.
   */
  isTagGroupDeclared(kind: 'ephemeral' | 'persistent', group: string): boolean;

  /** The runtime validator for a tag group, or `undefined` when it has none. */
  getTagGroupSchema(kind: 'ephemeral' | 'persistent', group: string): Validator | undefined;

  /**
   * Builder for the `ctx.tags` surface, registered by the `tags()` capability.
   * Absent when no tag groups are declared, so the tag runtime stays out of the
   * bundle.
   */
  buildTagsApi?: FeatureSlots.BuildTagsApi;

  /**
   * Builders for the `ctx.channels` / `ctx.channel` surface, registered by the
   * `channels()` capability. Absent otherwise, so the channel-context module
   * stays out of a handler that lists no channels.
   */
  channelContext?: FeatureSlots.ChannelContext;

  /**
   * Augmenters that graft extra members onto every channel handle, registered by
   * capabilities that own a per-channel surface (inbox, read receipts). Empty
   * when none are listed, so `buildChannelHandle` stays inbox-agnostic.
   */
  channelHandleAugmenters?: readonly FeatureSlots.ChannelHandleAugmenter[];
}

/**
 * Extra data required when building a live connection context.
 */
export interface BuildConnectionContextDeps extends ContextCommonDeps {
  compiled: EngineCompileTypes.CompiledServer;
  connections: Map<string, EngineRuntimeTypes.RuntimeConnection>;
  /** User-key → members index backing `ctx.user` / `ctx.users` fan-out. */
  usersByKey: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;
  tagMembers: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;
}

/**
 * Extra data required when building a task or shutdown context.
 */
export interface CreateTaskContextDeps extends ContextCommonDeps {
  connections: Map<string, EngineRuntimeTypes.RuntimeConnection>;
  /** User-key → members index, backing the connectionless `ctx.users` surface. */
  usersByKey: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;
}
