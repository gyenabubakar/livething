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

import type { AnyRecordedStream } from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ResolvedChannel, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { buildChannelFamilyExtra, buildChannelsApi } from '~/channel/context.ts';
import type * as ChannelRuntime from '~/channel/runtime.ts';
import type { MembershipInsert, MembershipKey, StoredMembership } from '~/channel/storage.ts';
import type { ConnectionInfo, ConnectionRef } from '~/context.ts';
import type {
  BufferStreamNudgeOptions,
  RunStreamOptions,
  StopChannelStreamsOptions,
} from '~/stream/runtime.ts';
import type { TagsRuntime } from '~/tags/runtime.ts';
import type { TagsApi } from '~/tags/types.ts';
import type { AnyUpload } from '~/upload/upload.ts';

type OptionsParameter = { continueScope: ResolvedChannel; streamId: string; lastKnownSeq: number };
type OptionsParameter2 = { streamId: string; cancelScope: ResolvedChannel };
type OptionsParameter3 = {
  connection: RuntimeConnection;
  ctx: Record<PropertyKey, unknown>;
  scope: ResolvedChannel;
  event: string;
  request: any;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
  bytes?: Uint8Array;
};
type OptsParameter = { taskId: string; time: number; data: unknown };
type OptsParameter2 = { taskId: string; filter?: Record<string, unknown> };
type ScopeParameter = { channelName: string; channelFamily: string | null };
type InboxMessageParameter = {
  channelName: string;
  channelFamily: string | null;
  event: string;
  payload: Record<string, unknown> | null;
  /** The bytes of a binary event. */
  bytes?: Uint8Array;
  messageId: string;
};
type OptsParameter3 = InboxMessageParameter & { deliverySeq: number };
type KeyParameter = { userId: string; channelName: string; channelFamily: string | null };

/**
 * Build the `ctx.tags` surface for one connection. Set by the `tags()`
 * capability, so a handler with no tag groups never pulls the group-handle
 * runtime into its bundle.
 */
export type BuildTagsApi = (runtime: TagsRuntime, connection: RuntimeConnection) => TagsApi;

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

/**
 * Stop the streams a connection runs in a channel it just left. Shared by plain
 * and durable streams, so it is set when either kind is listed.
 */
export type StreamChannelLeave = (
  runtime: any,
  connection: RuntimeConnection,
  options: StopChannelStreamsOptions,
) => Promise<void>;

/** Options the durable trigger needs to start a durable stream. */
export interface DurableTriggerOptions {
  scope: ResolvedChannel;
  /** The compiled recorded stream the durable runtime builds its def from. */
  durable: AnyRecordedStream;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
  /** The bytes of the frame that started a binary stream, else `undefined`. */
  bytes?: Uint8Array;
}

/** The durable-stream dispatch surface. Set when the `recordedStream()` capability is listed. */
export interface DurableStreamService {
  /** Start a matched durable stream. */
  trigger(
    runtime: any,
    connection: RuntimeConnection,
    options: DurableTriggerOptions,
  ): Promise<void>;
  /** Handle a client `__continueStream__` frame. */
  continue(runtime: any, connection: RuntimeConnection, options: OptionsParameter): Promise<void>;
  /** Handle the durable side of a `__streamCancel__` frame. */
  cancel(runtime: any, connection: RuntimeConnection, options: OptionsParameter2): Promise<void>;
  /**
   * Delete the stored row of a durable stream whose creator left the stream's
   * channel. The caller has already stopped the generator.
   */
  endOnLeave(
    runtime: any,
    connection: RuntimeConnection,
    options: { streamId: string; scope: ResolvedChannel },
  ): void;
}

/** What the upload service needs to start or resume an upload. */
export interface UploadStartOptions {
  /** The upload handler the start frame names. */
  upload: AnyUpload;
  /** The input, already checked by the handler's schema. */
  payload: unknown;
  livething: Protocol.LiveThingProtocol;
}

/** One piece of a running upload: its `upload` metadata and its bytes. */
export interface UploadPieceOptions {
  /** The frame's event name, which must be the upload's. */
  event: string;
  livething: Protocol.LiveThingProtocol;
  bytes: Uint8Array | undefined;
}

/** The upload dispatch surface. Set when the `uploads()` capability is listed. */
export interface UploadService {
  /** Start or resume an upload, after its start frame passed the intercepts and the input check. */
  start(runtime: any, connection: RuntimeConnection, options: UploadStartOptions): Promise<void>;
  /**
   * Take one piece of a running upload. It settles when `run` reads the piece or the upload
   * ends, so the piece's bytes count against the connection until then.
   */
  piece(runtime: any, connection: RuntimeConnection, options: UploadPieceOptions): Promise<void>;
  /** Handle a client `__uploadEnd__` frame. */
  end(runtime: any, connection: RuntimeConnection, frame: Protocol.UploadEndFrame): Promise<void>;
  /**
   * Note that a start frame for this upload arrived and is being handled (intercepts, the
   * input check, a wait for an older run). Returns the function to call when that is over, so
   * a cancel that comes meanwhile knows a start is still coming.
   */
  starting(connection: RuntimeConnection, uploadId: string): () => void;
  /** Handle a client `__uploadCancel__` frame. */
  cancel(
    runtime: any,
    connection: RuntimeConnection,
    frame: Protocol.UploadCancelFrame,
  ): Promise<void>;
}

/**
 * Route one binary message that is within the receive limit. Set by the capability that
 * turns binary on. While it is unset, the engine closes the socket with `1003`.
 */
type BinaryMessageDispatch = (
  runtime: any,
  connection: RuntimeConnection,
  data: Uint8Array,
) => Promise<void>;

/**
 * Where a send method takes its event name: first (`send(event, ...)`) or second
 * (`broadcastTo(to, event, ...)`).
 */
export type SenderEventPosition = 'event-first' | 'event-second';

/**
 * Give a sender object a `.binary` key with a binary version of each named JSON send
 * method. Set by the `binary()` capability, so an object gets `.binary` only when it is listed.
 */
export type AddBinarySenders = (
  sender: object,
  methods: Readonly<Record<string, SenderEventPosition>>,
) => void;

/** The binary receive path and senders. Set by the `binary()` capability. */
export interface BinaryService {
  dispatch: BinaryMessageDispatch;
  addSenders: AddBinarySenders;
}

/** Execute a matched `.request(...)` handler. Set by the `serverRequests()` capability. */
export type RequestDispatch = (
  runtime: any,
  connection: RuntimeConnection,
  options: OptionsParameter3,
) => Promise<void>;

/**
 * Durable channel-membership operations. Set by the `channels()` capability,
 * so a handler without it never pulls the membership storage or rejoin code.
 * Each op already no-ops for an ephemeral channel (the default), so an unset
 * slot is the same as the ephemeral path.
 */
export interface ChannelMembershipService {
  persistMembership(core: any, row: MembershipInsert): void;
  deleteDurableMembership(core: any, key: MembershipKey): void;
  getDurableMembership(core: any, key: MembershipKey): StoredMembership | undefined;
  listDurableMembers(
    core: any,
    channelName: string,
    channelFamily: string | null,
  ): (StoredMembership & { userId: string })[];
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
 * Each method takes the engine's connectionless context factory, which builds
 * the `ctx` a scheduled task body receives.
 */
export interface ScheduledService {
  ensureRuntime(core: any, createContext: () => unknown): void;
  scheduleTask(core: any, createContext: () => unknown, opts: OptsParameter): void;
  cancelScheduled(core: any, createContext: () => unknown, opts: OptsParameter2): void;
  rescheduleAlarm(core: any): void;
}

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
  retention?: { maxAgeMs?: number; maxMessages?: number; maxBytes?: number };
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
  /** The last-seen timestamp (ms) for a user, or `null` when never seen. */
  at(userId: string): number | null;
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
  scope: ScopeParameter,
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
  fanOut(core: any, opts: OptsParameter3): void;
  /**
   * Whether the channel's inbox can store this message. When it cannot, the broadcast goes to
   * nobody, and this has logged why. Runs before the message is recorded or sent.
   */
  canStore(core: any, message: InboxMessageParameter): boolean;
  /**
   * Re-deliver a user's owed rows after its socket reconnects. It settles when the last row is
   * sent, which can be after waits for the socket's buffer.
   */
  drainOnReconnect(core: any, connection: RuntimeConnection): Promise<void>;
  /** Drop a user's rows for a channel it has just left. */
  clearChannel(core: any, key: KeyParameter): void;
}
