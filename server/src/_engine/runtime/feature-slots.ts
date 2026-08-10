/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Type-only definitions for the runtime dispatch slots a feature capability
 * fills during `__setup`.
 *
 * The dispatch hub (`messages.ts`) is feature-agnostic: instead of importing a
 * stream, durable-stream, or request runtime directly, it reads these optional
 * slots off the live runtime bag and calls them. A slot is set only when the
 * owning capability is listed, so a bare incoming/outgoing handler never pulls
 * the feature runtime into its bundle.
 *
 * Every import here is type-only, so referencing the feature runtimes for their
 * function signatures carries zero bundle cost.
 */

import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ResolvedChannel, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { buildChannelFamilyExtra, buildChannelsApi } from '~/channel/context.ts';
import type * as ChannelRuntime from '~/channel/runtime.ts';
import type { MembershipKey } from '~/channel/storage.ts';
import type { ConnectionInfo, ConnectionRef, SQLProvider } from '~/context.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { RunInterceptsOptions } from '~/intercept/runtime.ts';
import type { ScheduledCancelResult } from '~/scheduled/types.ts';
import type { BufferStreamNudgeOptions, RunStreamOptions } from '~/stream/runtime.ts';
import type { TagsApi } from '~/tags/types.ts';

/**
 * Build the `ctx.tags` surface for one connection. Set by the `tags()`
 * capability, so a handler with no tag groups never pulls the group-handle
 * runtime into its bundle.
 */
export type BuildTagsApi = (runtime: any, connection: RuntimeConnection) => TagsApi;

/** Start one matched plain (ephemeral) stream. Set by the `stream()` capability. */
export type StreamTrigger = (
  runtime: any,
  connection: RuntimeConnection,
  options: RunStreamOptions,
) => Promise<void>;

/**
 * Buffer a nudge for a live active stream. Shared by plain and durable streams,
 * so it is set when either kind is listed. Returns `true` when the frame
 * belonged to an active stream and normal routing should stop.
 */
export type StreamNudgeBuffer = (
  runtime: any,
  connection: RuntimeConnection,
  options: BufferStreamNudgeOptions,
) => Promise<boolean>;

/** Cancel a live active stream by id. Shared by plain and durable streams. */
export type StreamCancel = (
  runtime: any,
  connection: RuntimeConnection,
  streamId: string,
) => Promise<void>;

/** Options the durable trigger needs to start a resumable/recorded stream. */
export interface DurableTriggerOptions {
  scope: ResolvedChannel;
  /** The compiled resumable/recorded stream the durable runtime builds its def from. */
  durable: any;
  kind: 'resumable' | 'recorded';
  payload: unknown;
  wskit: Protocol.WSKitProtocol | undefined;
}

/**
 * The durable-stream dispatch surface. Set once (idempotently) when either the
 * `resumableStream()` or `recordedStream()` capability is listed.
 */
export interface DurableStreamService {
  /** Create the durable-stream tables if this engine has not done so yet. */
  ensureSchema(runtime: any): void;
  /** Start a matched durable stream. */
  trigger(
    runtime: any,
    connection: RuntimeConnection,
    options: DurableTriggerOptions,
  ): Promise<void>;
  /** Handle a client `__resumeStream__` frame. */
  resume(
    runtime: any,
    connection: RuntimeConnection,
    options: { resumeScope: ResolvedChannel; streamId: string; lastKnownSeq: number },
  ): Promise<void>;
  /** Handle the durable side of a `__streamCancel__` frame. */
  cancel(
    runtime: any,
    connection: RuntimeConnection,
    options: { streamId: string; cancelScope: ResolvedChannel },
  ): Promise<void>;
}

/** Execute a matched `.request(...)` handler. Set by the `requests()` capability. */
export type RequestDispatch = (
  runtime: any,
  connection: RuntimeConnection,
  options: {
    connection: RuntimeConnection;
    ctx: Record<PropertyKey, unknown>;
    scope: ResolvedChannel;
    event: string;
    request: any;
    payload: unknown;
    wskit: Protocol.WSKitProtocol | undefined;
  },
) => Promise<void>;

/**
 * Durable channel-membership operations. Set by the `channels()` capability,
 * so a handler without it never pulls the membership storage or rejoin code.
 * Each op already no-ops for a channel opted out with `persistent: false`, so
 * an unset slot is the same as the opted-out path.
 */
export interface ChannelMembershipService {
  persistMembership(core: any, key: MembershipKey): void;
  deleteDurableMembership(core: any, key: MembershipKey): void;
  hasDurableMembership(core: any, key: MembershipKey): boolean;
  autoRejoinIdentity(
    core: any,
    subscribeFromServer: any,
    connection: RuntimeConnection,
  ): Promise<void>;
}

/**
 * The persistent-tag restore operation. Set by the `tags()` capability, so a
 * handler without it never pulls the tag storage or rejoin code.
 */
export interface TagPersistenceService {
  restorePersistentTags(opts: any): void;
}

/**
 * Scheduled-task runtime. Set when `scheduled()` is listed (for `ctx.schedule`)
 * or when a durable stream is listed (its retention sweep is a scheduled task),
 * so a handler with neither never pulls the scheduler or the task context.
 *
 * Each method takes the engine's `commonDeps` so the service can build a task
 * context without the engine importing the scheduled context builder.
 */
export interface ScheduledService {
  ensureRuntime(core: any, commonDeps: any): void;
  scheduleTask(
    core: any,
    commonDeps: any,
    opts: { taskId: string; time: number; data: unknown },
  ): void;
  cancelScheduled(
    core: any,
    commonDeps: any,
    opts: { taskId: string; filter?: Record<string, unknown> },
  ): ScheduledCancelResult;
  rescheduleAlarm(core: any): void;
  createTaskContext(core: any, commonDeps: any): unknown;
}

/**
 * The intercept pipeline runner. Set by the `intercepts()` capability, so a
 * handler that never lists it skips the intercept block and never bundles the
 * pipeline runner.
 */
export type RunIntercepts = (
  runtime: any,
  connection: RuntimeConnection,
  options: RunInterceptsOptions,
) => Promise<InterceptFrame>;

/**
 * The channel subscribe/leave/kick runtime. Set by the `channels()` capability,
 * so a handler without it never pulls the membership-protocol engine, the
 * subscribe/unsubscribe frame handlers, or the member-sync code. Each method
 * takes the engine `core` and builds its own dependency bag, so the engine never
 * imports the channel runtime to call them.
 */
export interface ChannelService {
  handleSubscribe(
    core: any,
    connection: RuntimeConnection,
    frame: Protocol.SubscribeFrame,
  ): Promise<void>;
  handleUnsubscribe(
    core: any,
    connection: RuntimeConnection,
    frame: Protocol.UnsubscribeFrame,
  ): Promise<void>;
  handleMemberSync(
    core: any,
    connection: RuntimeConnection,
    frame: Protocol.MemberSyncRequestFrame,
  ): void;
  leaveChannel(
    core: any,
    connection: RuntimeConnection,
    opts: ChannelRuntime.LeaveChannelOptions,
  ): Promise<void>;
  getChannelMembers(
    core: any,
    channelName: string,
    channelFamily: string | null,
  ): ConnectionInfo<Record<string, unknown>>[];
  kickChannelMembers(core: any, opts: ChannelRuntime.KickChannelMembersOptions): Promise<void>;
  subscribeFromServer(
    core: any,
    ref: ConnectionRef,
    opts: Omit<ChannelRuntime.SubscribeConnectionAsServerOptions, 'rejoining'> & {
      rejoining?: boolean;
    },
  ): Promise<void>;
}

/**
 * The `ctx.channels` / `ctx.channel` surface builders. Set by the `channels()`
 * capability so the connection context exposes the channel accessor without the
 * engine statically importing the channel-context module.
 */
export interface ChannelContext {
  buildChannelsApi: typeof buildChannelsApi;
  buildChannelFamilyExtra: typeof buildChannelFamilyExtra;
}

/** Inbox settings resolved for one channel, stored on the engine core. */
export interface ResolvedInboxOptions {
  onDelivered: 'delete' | 'retain';
  retention?: { maxAgeMs?: number; maxMessages?: number };
  /** Whether the delivered `__received__` tick is pushed live to other members. Off by default. */
  broadcastReceipts: boolean;
  /** Member cap for the delivered `__received__` fan-out. Defaults to 256. */
  maxReceiptAudience: number;
}

/** Read-receipts settings resolved for one channel, stored on the engine core. */
export interface ResolvedReadReceiptsOptions {
  /** Member cap for the read `__read__` fan-out. Defaults to 256. */
  maxReceiptAudience: number;
}

/**
 * The last-seen dispatch surface. Set by the `lastSeen()` capability, so a
 * handler without it never pulls the last-seen storage. Other capabilities read
 * it off the engine core through this slot with a type-only import, keeping
 * `last-seen/` tree-shaken out when unused.
 */
export interface LastSeenService {
  /** The last-seen timestamp (ms) for an identity, or `null` when never seen. */
  at(identity: string): number | null;
  /** Whether an identity has a live connection on this instance right now. */
  online(identity: string): boolean;
}

/**
 * A function that grafts extra members onto a freshly built channel handle. Set
 * by capabilities that own a per-channel surface reachable from any handle
 * (inbox, read receipts), so `channels()` never value-imports them. Each runs
 * against every handle `buildChannelHandle` produces — both `ctx.channel` and
 * `ctx.channels.get(...)`.
 */
export type ChannelHandleAugmenter = (
  handle: Record<PropertyKey, unknown>,
  scope: { channelName: string; channelFamily: string | null },
) => void;

/**
 * The inbox dispatch surface. Set by the `inbox()` capability, so a handler
 * without it never pulls the inbox storage, fan-out, or drain code. `fanOut`
 * runs once per logical channel broadcast (not once per recipient); the other
 * methods run on reconnect drain and on leave.
 */
export interface InboxService {
  /**
   * Write a per-member copy for every durable member of the channel, keyed on
   * the `seq`/`messageId` the broadcast already stamped so each row matches the
   * live frame the member also receives.
   */
  fanOut(
    core: any,
    opts: {
      channelName: string;
      channelFamily: string | null;
      event: string;
      payload: Record<string, unknown>;
      seq: number;
      messageId: string;
    },
  ): void;
  /** Re-deliver a user's owed rows after its socket reconnects. */
  drainOnReconnect(core: any, connection: RuntimeConnection): void;
  /** Drop a user's rows for a channel it has just left. */
  clearChannel(
    core: any,
    key: { userId: string; channelName: string; channelFamily: string | null },
  ): void;
}

/** The bag of optional feature slots the engine core carries. */
export interface FeatureDispatchSlots {
  streamTrigger?: StreamTrigger;
  streamNudgeBuffer?: StreamNudgeBuffer;
  streamCancel?: StreamCancel;
  durableStream?: DurableStreamService;
  requestDispatch?: RequestDispatch;
  channelService?: ChannelService;
  channelContext?: ChannelContext;
  inboxService?: InboxService;
  lastSeenService?: LastSeenService;
}

/** Re-exported so the durable dispatch service can satisfy the runtime contract. */
export type { SQLProvider };
