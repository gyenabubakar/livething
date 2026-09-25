/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  ChannelNotFound,
  ChannelNotSubscribed,
  LiveThingConfigError,
  RejoinRejected,
  rethrowIfConfigError,
} from '@livething/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import { userKeyOf } from '~/_engine/runtime/user-key.ts';
import type { CompiledChannel } from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ChannelHooks, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { MembershipInsert, StoredMembership } from '~/channel/storage.ts';
import type { ConnectionInfo, Logger } from '~/context.ts';
import type { NotifyValidationErrorOptions, SendRuntimeErrorOptions } from '~/errors/runtime.ts';

type ScopeParameter = {
  channel?: CompiledChannel;
  channelName?: string;
  channelFamily?: string | null;
  isSubscribeGate?: boolean;
};
type OptionsParameter = { force?: boolean };
type OptsParameter = {
  event: string;
  payload: Record<string, unknown>;
  livething: Record<string, unknown>;
};
type RollbackFailedSubscribeOptsParameter = {
  scope: ResolvedChannelTarget;
  isDurable: boolean;
  /** The stored row read before this subscribe wrote its own. */
  stored: StoredMembership | undefined;
};

/**
 * Tracks which channel a connection is subscribed to.
 *
 * `channelFamily` is `null` for static channels and a non-empty family key for
 * dynamic channel families. The two cases never collapse into the same shape.
 */
export interface ChannelMembership {
  channelName: string;
  channelFamily: string | null;
}

/**
 * Build a unique string key from a channel name and explicit family marker.
 * Pass `null` for static channels and the family key for dynamic families.
 */
export function createChannelMembershipKey(
  channelName: string,
  channelFamily: string | null,
): string {
  return JSON.stringify([channelFamily, channelName]);
}

/** Record that a connection has joined a channel, updating the member index. */
export function addChannelMembership(
  channelMembers: Map<string, Set<RuntimeConnection>>,
  connection: RuntimeConnection,
  membership: ChannelMembership,
): void {
  const key = createChannelMembershipKey(membership.channelName, membership.channelFamily);
  connection.channelMemberships.set(key, membership);

  let members = channelMembers.get(key);
  if (!members) {
    members = new Set();
    channelMembers.set(key, members);
  }

  members.add(connection);
}

/** Check whether a connection is currently subscribed to a channel. */
export function hasChannelMembership(
  connection: Pick<RuntimeConnection, 'channelMemberships'>,
  channelName: string,
  channelFamily: string | null,
): boolean {
  return connection.channelMemberships.has(createChannelMembershipKey(channelName, channelFamily));
}

/** Remove a connection's subscription to a channel, updating the member index. */
export function removeChannelMembership(
  channelMembers: Map<string, Set<RuntimeConnection>>,
  connection: RuntimeConnection,
  membership: ChannelMembership,
): void {
  const key = createChannelMembershipKey(membership.channelName, membership.channelFamily);
  connection.channelMemberships.delete(key);

  const members = channelMembers.get(key);
  if (members) {
    members.delete(connection);
    // Drop the empty set so churned dynamic channels do not leak keys.
    if (members.size === 0) channelMembers.delete(key);
  }
}

/** Get all channel membership entries for a connection. */
export function listChannelMemberships(
  connection: Pick<RuntimeConnection, 'channelMemberships'>,
): ChannelMembership[] {
  return [...connection.channelMemberships.values()];
}

/**
 * Check whether a concrete channel name satisfies a compiled channel's pattern.
 * Static channels carry a string pattern (always passes — exact lookup is the
 * gate). Dynamic families carry a `ScopeDeclaration` with a regex; the name
 * must match the regex to be accepted.
 */
export function matchesFamilyPattern(
  pattern: CompiledChannel['pattern'],
  channelName: string,
): boolean {
  if (typeof pattern === 'string') return true;

  return pattern.pattern.test(channelName);
}

/**
 * Extract the `{name}` captures from a concrete channel name. Returns an empty
 * object for static channels (string pattern) and for dynamic families whose
 * template declared no params. Surfaced as `ctx.channel.params`.
 */
export function matchScopeParams(
  pattern: CompiledChannel['pattern'],
  channelName: string,
): Record<string, string> {
  if (typeof pattern === 'string') return {};

  const match = pattern.pattern.exec(channelName);
  return match?.groups ? { ...match.groups } : {};
}

/**
 * Look up a compiled channel definition by name. Pass `null` to look up a
 * static channel by name; pass a family key to look up a dynamic channel
 * family.
 */
export function resolveCompiledChannel(
  compiled: Pick<ChannelRuntime['compiled'], 'channels' | 'channelFamilies'>,
  channelName: string,
  channelFamily: string | null,
): CompiledChannel | undefined {
  return channelFamily === null
    ? compiled.channels.get(channelName)
    : compiled.channelFamilies.get(channelFamily);
}

export interface BroadcastToChannelOptions {
  channelName: string;

  event: string;

  payload: unknown;

  excludeConnectionId: string | undefined;

  channelFamily: string | null;

  /** Whether to also deliver to `excludeConnectionId`. Defaults to `false`. */
  includeSelf?: boolean;
}

/**
 * The shared engine surface channel protocol helpers need.
 *
 * The engine keeps membership state and connection lookup. These helpers own
 * the subscribe and unsubscribe protocol behavior built on top of that state.
 */
interface ChannelRuntime extends ChannelHooks {
  compiled: {
    channels: Map<string, CompiledChannel>;
    channelFamilies: Map<string, CompiledChannel>;
  };

  connections: Map<string, RuntimeConnection>;

  channelMembers: Map<string, Set<RuntimeConnection>>;

  toConnectionInfo(connection: RuntimeConnection): ConnectionInfo<Record<string, unknown>>;

  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ScopeParameter,
  ): Record<PropertyKey, unknown>;

  persistAttachment(connection: RuntimeConnection, options?: OptionsParameter): void;

  sendProtocolMessage(connection: RuntimeConnection, opts: OptsParameter): void;

  broadcastToChannel(opts: BroadcastToChannelOptions): void;

  handleValidationError(
    connection: RuntimeConnection,
    opts: NotifyValidationErrorOptions,
  ): Promise<void>;

  handleRuntimeError(connection: RuntimeConnection, opts: SendRuntimeErrorOptions): Promise<void>;

  logger?: Pick<Logger, 'error'>;

  /**
   * Whether the given channel-key should write durable memberships. Returns
   * `false` only when the channel set `membership: 'ephemeral'` in its
   * definition — every other channel is durable by default. The runtime gates
   * every membership write through this so an opted-out channel pays no SQL
   * cost.
   */
  isChannelDurable(channelKey: string): boolean;

  /**
   * Insert or replace a durable membership row for the given user, with the
   * joining connection's meta. Called after a successful subscribe to a
   * persistent channel. No-op when the channel is not persistent.
   */
  persistMembership(row: MembershipInsert): void;

  /**
   * Delete a durable membership row for the given user. Called on a TRUE
   * leave (client `__unsubscribe__`, revoking `kick`) of a persistent
   * channel. Disconnect path skips this so the user stays in the group across
   * reconnects.
   */
  deleteDurableMembership(userId: string, channelName: string, channelFamily: string | null): void;

  /** Read the user's durable membership row for this channel, if any. */
  getDurableMembership(
    userId: string,
    channelName: string,
    channelFamily: string | null,
  ): StoredMembership | undefined;

  /**
   * Mark the user's durable membership row as kicked. Called when a kick that
   * does not revoke ends the member: the row stays for the next rejoin, but
   * the roster no longer lists the user.
   */
  markDurableMembershipKicked(
    userId: string,
    channelName: string,
    channelFamily: string | null,
  ): void;

  /** Read every durable membership row of a channel, for the member roster. */
  listDurableMembers(
    channelName: string,
    channelFamily: string | null,
  ): (StoredMembership & { userId: string })[];

  /**
   * Drop the user's inbox rows for this channel. Called on a true leave —
   * they stop being owed the channel's messages. No-op when `inbox()` is off.
   */
  clearInbox?(userId: string, channelName: string, channelFamily: string | null): void;

  /**
   * Whether this channel is inbox-backed. Stamped onto `__subscribeOk__` so the
   * client acks only inbox channels. Absent (treated as `false`) when `inbox()`
   * is off.
   */
  isInboxChannel?(channelName: string, channelFamily: string | null): boolean;

  /**
   * Whether this channel opted into read receipts. Stamped onto `__subscribeOk__`
   * so the client exposes `markAsRead`/`readers`/`readersOf` only where they work.
   */
  isReadReceiptsChannel?(channelName: string, channelFamily: string | null): boolean;

  /**
   * Stop the streams the connection runs in a channel it just left. Absent when
   * no stream capability is listed.
   */
  stopChannelStreams?(connection: RuntimeConnection, opts: StopChannelStreamsInput): Promise<void>;
}

interface StopChannelStreamsInput {
  channelName: string;
  channelFamily: string | null;
  /** True when the user has no connection left in the channel. */
  userGone: boolean;
}

interface ChannelTarget {
  channel?: CompiledChannel;
  channelName: string;
  channelFamily: string | null;
}

interface ResolvedChannelTarget {
  channel: CompiledChannel;
  channelName: string;
  channelFamily: string | null;
}

/**
 * Resolve a compiled channel from the `channel` + `channelFamily` markers a
 * `__subscribe__` / `__unsubscribe__` frame carried on its `__livething` block.
 * Returns `undefined` when the channel does not exist or the concrete name
 * fails the family pattern.
 */
function resolveChannelByName(
  runtime: Pick<ChannelRuntime, 'compiled'>,
  channelName: string,
  channelFamily: string | null,
): ResolvedChannelTarget | undefined {
  const channel =
    channelFamily === null
      ? runtime.compiled.channels.get(channelName)
      : runtime.compiled.channelFamilies.get(channelFamily);

  if (!channel) return;

  if (!matchesFamilyPattern(channel.pattern, channelName)) return;

  return { channel, channelName, channelFamily };
}

/** Build the `__livething` routing block for a channel-scoped protocol frame. */
function buildChannelRouting(scope: ChannelTarget): Record<string, unknown> {
  const livething: Record<string, unknown> = { channel: scope.channelName };
  if (scope.channelFamily !== null) livething.channelFamily = scope.channelFamily;
  return livething;
}

/**
 * Leave a channel, run channel lifecycle hooks, and notify remaining members.
 */
export interface LeaveChannelOptions {
  channel?: CompiledChannel;

  channelName: string;

  channelFamily: string | null;

  kickedReason?: string;

  /** `true` on socket close. On a persistent channel it keeps the durable row and skips `onUnsubscribe`. */
  disconnect?: boolean;

  /**
   * `true` to keep the durable membership row on an otherwise-true leave, so
   * the user auto-rejoins the channel on their next reconnect. The row is
   * marked kicked, so the roster leaves the user out until then. Set by a
   * non-revoking `kick`. Ignored on a plain disconnect, which already keeps
   * the row via `disconnect`.
   */
  keepDurableRow?: boolean;
}

/**
 * Whether this connection holds a per-user seat in the channel. A persistent
 * channel keeps membership per user, so a signed-in connection is one socket
 * of that user's seat. An ephemeral channel, or an anonymous connection (no
 * user id, so no stored row), gets a seat that lasts only as long as the socket.
 */
function holdsUserSeat(connection: RuntimeConnection, isDurable: boolean | undefined): boolean {
  return isDurable === true && connection.userId !== '';
}

/**
 * The id peers see for this member in presence frames: the user id for a
 * per-user seat, so it stays the same across reconnects and tabs, and the
 * connection id otherwise.
 */
function memberIdOf(connection: RuntimeConnection, userSeat: boolean): string {
  return userSeat ? connection.userId : connection.id;
}

/** Whether another live connection of this user is still in the channel. */
function userHasLiveConnectionIn(
  runtime: Pick<ChannelRuntime, 'channelMembers'>,
  scope: ChannelTarget,
  connection: RuntimeConnection,
): boolean {
  if (connection.userId === '') return false;

  const members = runtime.channelMembers.get(
    createChannelMembershipKey(scope.channelName, scope.channelFamily),
  );
  for (const member of members ?? []) {
    if (member !== connection && member.userId === connection.userId) return true;
  }

  return false;
}

interface ClearDurableLeaveStateInput {
  scope: ChannelTarget;
  isTrueLeave: boolean;
  isDurable: boolean | undefined;
  keepDurableRow: boolean | undefined;
}

/**
 * Update the stored membership when the last connection of a member truly
 * leaves: drop the row, or, for a kick that keeps it, mark it kicked so the
 * roster stops listing the user until they rejoin.
 */
function clearDurableLeaveState(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  input: ClearDurableLeaveStateInput,
): void {
  const { scope, isTrueLeave, isDurable, keepDurableRow } = input;
  if (
    !isTrueLeave ||
    (!isDurable && scope.channel) ||
    userHasLiveConnectionIn(runtime, scope, connection)
  ) {
    return;
  }

  if (keepDurableRow) {
    if (holdsUserSeat(connection, isDurable)) {
      runtime.markDurableMembershipKicked(
        connection.userId,
        scope.channelName,
        scope.channelFamily,
      );
    }

    return;
  }

  runtime.deleteDurableMembership(connection.userId, scope.channelName, scope.channelFamily);

  if (connection.userId)
    runtime.clearInbox?.(connection.userId, scope.channelName, scope.channelFamily);
}

export async function leaveChannel(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  opts: LeaveChannelOptions,
): Promise<void> {
  const { kickedReason, disconnect, keepDurableRow } = opts;
  const scope: ChannelTarget = opts;
  if (!hasChannelMembership(connection, scope.channelName, scope.channelFamily)) return;

  const ctx = runtime.buildConnectionContext(connection, scope);
  const channelKey = scope.channel?.key ?? '';
  const isDurable = runtime.isChannelDurable(scope.channelFamily ?? scope.channelName);
  const userSeat = holdsUserSeat(connection, isDurable);
  const memberId = memberIdOf(connection, userSeat);

  // A disconnect only ends the session when the user keeps a seat to come
  // back to. Every other path also changes group membership.
  const isTrueLeave = !disconnect || !userSeat;

  // Remove membership before running any async hooks. A concurrent leave
  // will see the member already gone and stop early.
  removeChannelMembership(runtime.channelMembers, connection, scope);
  runtime.persistAttachment(connection);

  // Another tab of the same user keeps the member present. Checked now, so
  // parallel leaves of one user (a kick) broadcast once, and again before the
  // broadcast, so a tab that joined during the hooks keeps the member present.
  const lastLiveConnection = !userSeat || !userHasLiveConnectionIn(runtime, scope, connection);
  function memberGone(): boolean {
    return (
      lastLiveConnection && (!userSeat || !userHasLiveConnectionIn(runtime, scope, connection))
    );
  }

  clearDurableLeaveState(runtime, connection, { scope, isTrueLeave, isDurable, keepDurableRow });

  // Hold the first hook throw and re-throw at the end so the rest of the leave
  // still runs. Callers still see the rejection.
  let firstHookError: unknown;

  // A socket close already stopped the connection's streams before its
  // channels are left. Any other leave stops the streams scoped to this channel.
  if (!disconnect && runtime.stopChannelStreams) {
    try {
      await runtime.stopChannelStreams(connection, {
        channelName: scope.channelName,
        channelFamily: scope.channelFamily,
        userGone: !userHasLiveConnectionIn(runtime, scope, connection),
      });
    } catch (error) {
      firstHookError = error;
    }
  }

  if (isTrueLeave) {
    for (const hook of runtime.unsubscribeHooks.get(channelKey) ?? []) {
      try {
        await hook(ctx);
      } catch (error) {
        runtime.logger?.error('[livething] onUnsubscribe hook threw', {
          connectionId: connection.id,
          channel: scope.channelName,
          channelFamily: scope.channelFamily,
          error: error instanceof Error ? error.message : String(error),
        });
        if (firstHookError === undefined) firstHookError = error;
      }
    }
  }

  if (kickedReason) {
    runtime.sendProtocolMessage(connection, {
      event: '__kicked__',
      payload: { reason: kickedReason },
      livething: buildChannelRouting(scope),
    });
  }

  // Order: __memberLeave__ before __memberOffline__ — peers update the member
  // list before reacting to the presence change.
  if (memberGone()) {
    if (isTrueLeave) {
      runtime.broadcastToChannel({
        channelName: scope.channelName,
        event: '__memberLeave__',
        payload: { memberId, meta: connection.meta },
        excludeConnectionId: connection.id,
        channelFamily: scope.channelFamily,
      });
    }

    runtime.broadcastToChannel({
      channelName: scope.channelName,
      event: '__memberOffline__',
      payload: { memberId },
      excludeConnectionId: connection.id,
      channelFamily: scope.channelFamily,
    });
  }

  for (const hook of runtime.sessionEndHooks.get(channelKey) ?? []) {
    try {
      await hook(ctx);
    } catch (error) {
      runtime.logger?.error('[livething] onSessionEnd hook threw', {
        connectionId: connection.id,
        channel: scope.channelName,
        channelFamily: scope.channelFamily,
        error: error instanceof Error ? error.message : String(error),
      });
      if (firstHookError === undefined) firstHookError = error;
    }
  }

  if (firstHookError !== undefined) throw firstHookError;
}

/**
 * Brings a connection into a channel.
 * Used by both client-initiated subscribes and server-side subscribes.
 */
interface RunSubscribeFlowOptions {
  channel: CompiledChannel;

  channelName: string;

  channelFamily: string | null;

  data: unknown;

  source: 'client' | 'server';

  /**
   * Restores a fresh socket from a stored membership. Runs `revalidate` instead
   * of `check`/`commit` and skips `onSubscribe`. Peers get `__memberOnline__`,
   * plus `__memberJoin__` first when a kick had ended the membership.
   */
  rejoining?: boolean;
}

interface SubscribeGatesInput {
  runtime: ChannelRuntime;
  connection: RuntimeConnection;
  opts: RunSubscribeFlowOptions;
  scope: ResolvedChannelTarget;
}

/**
 * Run the async gates (`check`, or `revalidate` on a rejoin) and return the
 * sync `commit` gate. The caller runs that commit right before it writes the
 * membership, with no `await` between them, so a cap checked in `commit`
 * cannot be passed by two subscribes at once.
 */
async function runSubscribeGates(input: SubscribeGatesInput): Promise<() => void> {
  const { runtime, connection, opts, scope } = input;
  const { data, rejoining = false } = opts;
  let gateCtx: Record<PropertyKey, unknown> | undefined;
  function getGateCtx(): Record<PropertyKey, unknown> {
    return (gateCtx ??= runtime.buildConnectionContext(connection, {
      ...scope,
      isSubscribeGate: true,
    }));
  }

  let checkResult: unknown;
  if (rejoining) {
    const revalidateHook = runtime.revalidateHooks.get(scope.channel.key)?.[0];
    if (revalidateHook) {
      try {
        await revalidateHook(getGateCtx());
      } catch (error) {
        rethrowIfConfigError(error);
        throw RejoinRejected({ message: error instanceof Error ? error.message : String(error) });
      }
    }
  } else {
    const checkHook = runtime.checkHooks.get(scope.channel.key)?.[0];
    if (checkHook) {
      let validatedData: unknown = data;
      if (checkHook.validator) {
        try {
          validatedData = validateValue(checkHook.validator, data, '__subscribe__');
        } catch (error) {
          rethrowIfConfigError(error);
          await runtime.handleValidationError(connection, {
            event: '__subscribe__',
            validationError: error,
            scope,
          });
          throw error;
        }
      }

      checkResult = await checkHook.handler(getGateCtx(), validatedData);
    }
  }

  const commitHook = rejoining ? undefined : runtime.commitHooks.get(scope.channel.key)?.[0];

  return function runCommitGate(): void {
    if (!commitHook) return;

    const result: unknown = commitHook.handler(getGateCtx(), checkResult);
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      throw new LiveThingConfigError('commit() must be synchronous.');
    }
  };
}

async function runSubscribeFlow(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  opts: RunSubscribeFlowOptions,
): Promise<void> {
  const { source, rejoining = false } = opts;
  const scope: ResolvedChannelTarget = opts;

  if (!rejoining && hasChannelMembership(connection, scope.channelName, scope.channelFamily)) {
    return;
  }

  const ctx = runtime.buildConnectionContext(connection, scope);

  const runCommitGate = await runSubscribeGates({ runtime, connection, opts, scope });
  if (!rejoining && hasChannelMembership(connection, scope.channelName, scope.channelFamily))
    return;

  // Nothing awaits from here to addChannelMembership(), so commit sees the
  // members exactly as they are when the joiner is added.
  const isDurable = runtime.isChannelDurable(scope.channel.key);
  const stored = isDurable
    ? runtime.getDurableMembership(connection.userId, scope.channelName, scope.channelFamily)
    : undefined;
  if (rejoining && isDurable && !stored) return;

  const userSeat = holdsUserSeat(connection, isDurable);
  const memberId = memberIdOf(connection, userSeat);
  // A user seat is present while any tab of the user is live, and a member
  // while its stored row exists, even with no tab live. A kicked row is kept
  // for the rejoin, but peers already saw that member leave.
  const memberWasPresent = userSeat && userHasLiveConnectionIn(runtime, scope, connection);
  const memberAlreadyJoined =
    memberWasPresent || (userSeat && stored !== undefined && !stored.kicked);

  runCommitGate();

  // Write the durable membership row first. If the SQL write throws, the
  // connection must not already be a live member of a channel it was never
  // saved into.
  if (isDurable) {
    runtime.persistMembership({
      userId: connection.userId,
      channelName: scope.channelName,
      channelFamily: scope.channelFamily,
      meta: connection.meta,
    });
  }

  // Commit live membership before snapshotting the member list. Otherwise two
  // concurrent subscribes both snapshot empty and miss each other.
  addChannelMembership(runtime.channelMembers, connection, scope);

  runtime.persistAttachment(connection);

  const members = snapshotMembers(runtime, scope, connection);

  const livething = buildChannelRouting(scope);

  // Send confirmation before running onSubscribe, so a throwing hook cannot
  // delay or block it from reaching the client. The membership value tells the
  // client whether to leave this channel to server-driven auto-rejoin on
  // reconnect ('persistent') rather than re-subscribing it itself
  // ('ephemeral'). The inbox flag tells the client to ack this channel's
  // messages (and only inbox channels) with `__received__`.
  const confirmation: Record<string, unknown> = {
    ...livething,
    source,
    channelMembership: userSeat ? 'persistent' : 'ephemeral',
  };

  if (runtime.isInboxChannel?.(scope.channelName, scope.channelFamily)) {
    confirmation.inbox = true;
  }

  if (runtime.isReadReceiptsChannel?.(scope.channelName, scope.channelFamily)) {
    confirmation.readReceipts = true;
  }

  try {
    runtime.sendProtocolMessage(connection, {
      event: '__subscribeOk__',
      payload: {},
      livething: confirmation,
    });
  } catch (error) {
    rollbackFailedSubscribe(runtime, connection, { scope, isDurable, stored });
    throw error;
  }

  if (connection.closing) {
    rollbackFailedSubscribe(runtime, connection, { scope, isDurable, stored });
    return;
  }

  try {
    runtime.sendProtocolMessage(connection, {
      event: '__memberSync__',
      payload: { members },
      livething: { ...livething, source },
    });
  } catch (error) {
    rollbackFailedSubscribe(runtime, connection, { scope, isDurable, stored });
    throw error;
  }

  if (connection.closing) {
    rollbackFailedSubscribe(runtime, connection, { scope, isDurable, stored });
    return;
  }

  // Order: __memberJoin__ (group changed) before __memberOnline__ (presence).
  // A stored member coming back, or a new tab of a user already in the
  // channel, skips __memberJoin__. A user whose other tab is live skips both.
  if (!memberAlreadyJoined) {
    runtime.broadcastToChannel({
      channelName: scope.channelName,
      event: '__memberJoin__',
      payload: { memberId, meta: connection.meta },
      excludeConnectionId: connection.id,
      channelFamily: scope.channelFamily,
    });
  }

  if (!memberWasPresent) {
    runtime.broadcastToChannel({
      channelName: scope.channelName,
      event: '__memberOnline__',
      payload: { memberId, meta: connection.meta },
      excludeConnectionId: connection.id,
      channelFamily: scope.channelFamily,
    });
  }

  // Auto-rejoin does not fire onSubscribe — the user already joined once, and
  // the rejoin only restores a fresh socket. Re-running join side-effects (a
  // welcome push, a "X joined" broadcast) on every reconnect would be wrong.
  if (!rejoining) {
    for (const hook of runtime.subscribeHooks.get(scope.channel.key) ?? []) {
      try {
        await hook(ctx);
      } catch (error) {
        const routing: Protocol.LiveThingRouting = { channel: scope.channelName };
        if (scope.channelFamily !== null) routing.channelFamily = scope.channelFamily;
        await runtime.handleRuntimeError(connection, { error, event: '__subscribe__', routing });
        return;
      }
    }
  }
}

function rollbackFailedSubscribe(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  opts: RollbackFailedSubscribeOptsParameter,
): void {
  const { scope, isDurable, stored } = opts;
  removeChannelMembership(runtime.channelMembers, connection, scope);
  runtime.persistAttachment(connection, { force: true });
  if (!isDurable || connection.userId === '') return;

  // The user was already a stored member: keep the row as it was.
  if (stored) {
    if (stored.kicked) {
      runtime.markDurableMembershipKicked(
        connection.userId,
        scope.channelName,
        scope.channelFamily,
      );
    }

    return;
  }

  const members = runtime.channelMembers.get(
    createChannelMembershipKey(scope.channelName, scope.channelFamily),
  );
  const anotherConnectionForUser = [...(members ?? [])].some(
    (member) => member.userId === connection.userId,
  );
  if (anotherConnectionForUser) return;

  runtime.deleteDurableMembership(connection.userId, scope.channelName, scope.channelFamily);
  runtime.clearInbox?.(connection.userId, scope.channelName, scope.channelFamily);
}

/** One entry of a `__memberSync__` roster. */
interface SyncMember {
  memberId: string;
  meta: Record<string, unknown>;
  /** Whether the member has a live connection in the channel right now. */
  online: boolean;
}

type SnapshotRuntime = Pick<
  ChannelRuntime,
  'channelMembers' | 'isChannelDurable' | 'listDurableMembers'
>;

/**
 * Build the public member snapshot for a channel as `viewer` sees it: one entry
 * per member id, without the viewer's own member id. Several tabs of one user
 * in a persistent channel are one entry, with the first tab's meta. A
 * persistent channel also lists stored members with no live connection as
 * offline, with the meta saved when they last joined. A kicked row is left out:
 * peers already saw that member leave.
 */
function snapshotMembers(
  runtime: SnapshotRuntime,
  scope: ResolvedChannelTarget,
  viewer: RuntimeConnection,
): SyncMember[] {
  const isDurable = runtime.isChannelDurable(scope.channel.key);
  const viewerMemberId = memberIdOf(viewer, holdsUserSeat(viewer, isDurable));
  const memberKey = createChannelMembershipKey(scope.channelName, scope.channelFamily);
  const members = new Map<string, SyncMember>();
  for (const member of runtime.channelMembers.get(memberKey) ?? []) {
    const memberId = memberIdOf(member, holdsUserSeat(member, isDurable));
    if (memberId !== viewerMemberId && !members.has(memberId)) {
      members.set(memberId, { memberId, meta: member.meta, online: true });
    }
  }

  if (isDurable) {
    for (const row of runtime.listDurableMembers(scope.channelName, scope.channelFamily)) {
      if (row.kicked || row.userId === viewerMemberId || members.has(row.userId)) continue;

      members.set(row.userId, { memberId: row.userId, meta: row.meta, online: false });
    }
  }

  return [...members.values()];
}

export interface ResyncMembersOptions {
  channelName: string;
  channelFamily: string | null;
}

/**
 * Re-send the current member snapshot to one connection in response to a
 * client `__memberSync__` request. Best-effort: a non-member or unknown channel
 * is a silent no-op (the client asked to refresh a roster it may have already
 * dropped). The reply carries `source: 'server'`.
 */
export function resyncChannelMembers(
  runtime: SnapshotRuntime & Pick<ChannelRuntime, 'compiled' | 'sendProtocolMessage'>,
  connection: RuntimeConnection,
  opts: ResyncMembersOptions,
): void {
  const scope = resolveChannelByName(runtime, opts.channelName, opts.channelFamily);
  if (!scope) return;

  if (!hasChannelMembership(connection, scope.channelName, scope.channelFamily)) return;

  const members = snapshotMembers(runtime, scope, connection);
  runtime.sendProtocolMessage(connection, {
    event: '__memberSync__',
    payload: { members },
    livething: { ...buildChannelRouting(scope), source: 'server' },
  });
}

/**
 * Subscribe one connection to a channel and emit the protocol events that
 * bring it into sync with the current member list. Entry point for the
 * client-initiated path — invoked when a `__subscribe__` frame arrives.
 */
export interface SubscribeConnectionOptions {
  channelName: string;
  channelFamily: string | null;
  data: unknown;
}

export async function subscribeConnection(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  opts: SubscribeConnectionOptions,
): Promise<void> {
  const scope = resolveChannelByName(runtime, opts.channelName, opts.channelFamily);
  if (!scope) {
    throw ChannelNotFound();
  }

  await runSubscribeFlow(runtime, connection, { ...scope, data: opts.data, source: 'client' });
}

export interface SubscribeConnectionAsServerOptions {
  channelName: string;

  channelFamily: string | null;

  payload: unknown;

  rejoining?: boolean;
}

/**
 * Server-initiated subscribe. Invoked by `channelHandle.subscribe(ref, payload?)`
 * to add a connection to a channel without a wire frame.
 *
 * Resolves to a no-op when the connection is already a member of the target
 * channel — calling subscribe on an existing membership is treated as
 * "make sure they are in", not as a re-subscribe. The wire-level no-op means
 * no extra `__subscribeOk__` and no extra `__memberJoin__` reach the client.
 */
export async function subscribeConnectionAsServer(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  opts: SubscribeConnectionAsServerOptions,
): Promise<void> {
  const { channelName, channelFamily, payload, rejoining = false } = opts;
  const channel = resolveCompiledChannel(runtime.compiled, channelName, channelFamily);
  if (!channel || !matchesFamilyPattern(channel.pattern, channelName)) {
    throw ChannelNotFound();
  }

  if (hasChannelMembership(connection, channelName, channelFamily)) return;

  await runSubscribeFlow(runtime, connection, {
    channel,
    channelName,
    channelFamily,
    data: payload,
    source: 'server',
    rejoining,
  });
}

export interface UnsubscribeConnectionOptions extends ChannelMembership {
  /** Correlation id from the `__unsubscribe__` frame; echoed on `__unsubscribeOk__`. */
  unsubscribeId?: string;
}

/**
 * Unsubscribe one connection from a channel by delegating to the shared leave
 * helper, then confirm the leave to the client.
 *
 * The `unsubscribeId` is a correlation id, not a stored dedup key — idempotency
 * is judged against current membership. An id-bearing leave for a channel the
 * connection is no longer in (a resend after the first ack was lost on a drop)
 * is re-acked without re-running hooks or broadcasts. A leave with no id for a
 * non-member gets the `ChannelNotSubscribed` error — the reliable client
 * always sends an id, so only low-level senders hit that path. An unknown channel
 * is always `ChannelNotFound`.
 */
export async function unsubscribeConnection(
  runtime: ChannelRuntime & {
    leaveChannel(connection: RuntimeConnection, opts: LeaveChannelOptions): Promise<void>;
  },
  connection: RuntimeConnection,
  opts: UnsubscribeConnectionOptions,
): Promise<void> {
  const scope = resolveChannelByName(runtime, opts.channelName, opts.channelFamily);
  if (!scope) {
    throw ChannelNotFound();
  }

  const isMember = hasChannelMembership(connection, scope.channelName, scope.channelFamily);
  if (!isMember && opts.unsubscribeId === undefined) {
    throw ChannelNotSubscribed();
  }

  // leaveChannel removes the membership BEFORE running leave hooks, so a throwing
  // `onUnsubscribe`/`onSessionEnd` still leaves a completed leave. Capture the
  // throw, confirm the leave anyway (below), then rethrow so the engine still
  // surfaces the hook error — otherwise the client's `unsubscribe()` would hang
  // forever on a leave that actually succeeded.
  let hookError: unknown;
  let threw = false;
  if (isMember) {
    try {
      await runtime.leaveChannel(connection, scope);
    } catch (error) {
      hookError = error;
      threw = true;
    }
  }

  // Confirm the leave so the client can settle its pending op. Only when the
  // frame carried an id — a low-level sender that left without one gets no ack.
  if (opts.unsubscribeId !== undefined) {
    runtime.sendProtocolMessage(connection, {
      event: '__unsubscribeOk__',
      payload: {},
      livething: { ...buildChannelRouting(scope), unsubscribeId: opts.unsubscribeId },
    });
  }

  if (threw) throw hookError;
}

/**
 * Target accepted by `channelHandle.kick(...)` and engine-level kick. Resolves
 * to a connection-matching predicate at runtime:
 *
 * - `UserRef` — kick every one of that user's subscribed connections.
 * - `TagRef` — kick every socket holding this `(kind, group, key)` tag.
 * - `{ __livething: 'group-handle', kind, group }` — kick every socket with any
 *   key under this `(kind, group)`.
 *
 * To drop one specific socket without kicking the rest of its user's
 * connections, callers use `ctx.connections.get(ref).close()` instead.
 */
export type KickTarget =
  | { __livething: 'user-ref'; id: string; instance: string | undefined }
  | { __livething: 'tag-ref'; kind: 'ephemeral' | 'persistent'; group: string; key: string }
  | { __livething: 'group-handle'; kind: 'ephemeral' | 'persistent'; group: string };

function matchesKickTarget(connection: RuntimeConnection, target: KickTarget): boolean {
  if (target.__livething === 'user-ref') return userKeyOf(connection) === target.id;

  if (target.__livething === 'tag-ref') {
    return connection.tags[target.kind].get(target.group)?.has(target.key) ?? false;
  }

  return (connection.tags[target.kind].get(target.group)?.size ?? 0) > 0;
}

/**
 * A channel-scoped `broadcastTo`/`request` recipient: a specific socket
 * (`ConnectionRef`), a whole user (`UserRef`), or a tag / tag group. Every
 * target is intersected with the channel's current membership.
 */
export type ChannelRecipient =
  | { __livething: 'connection-ref'; id: string; instance: string | undefined; userId: string }
  | KickTarget;

/** Whether a connection satisfies a channel-scoped recipient. */
export function matchesRecipient(connection: RuntimeConnection, target: ChannelRecipient): boolean {
  if (target.__livething === 'connection-ref') return connection.id === target.id;

  return matchesKickTarget(connection, target);
}

/** Options for resolving a channel recipient to the member connections it addresses. */
export interface ResolveChannelRecipientsOptions {
  channelName: string;
  channelFamily: string | null;
  to: ChannelRecipient;
}

/**
 * Resolve a channel-scoped recipient to the subscribed connections it addresses.
 * The result is always a subset of the channel's current membership — a
 * recipient pointing at a non-member yields an empty list.
 */
export function resolveChannelRecipients(
  channelMembers: Map<string, Set<RuntimeConnection>>,
  opts: ResolveChannelRecipientsOptions,
): RuntimeConnection[] {
  const members = channelMembers.get(
    createChannelMembershipKey(opts.channelName, opts.channelFamily),
  );
  if (!members) return [];

  return [...members].filter((connection) => matchesRecipient(connection, opts.to));
}

/**
 * Remove targeted members from a channel, usually for moderation or access
 * control.
 *
 * Scoped to the exact `channelName + channelFamily` pair: kicks never cross
 * into a different channel family that happens to share a concrete name.
 *
 * Every triggered `leaveChannel` runs to completion, even when a leave hook of
 * another kicked connection throws. Once all of them finished, the kick rejects
 * with an `AggregateError` holding every failure.
 */
export interface KickChannelMembersOptions {
  channelName: string;

  target: KickTarget;

  reason: string;

  channelFamily: string | null;

  /**
   * When true, also delete each kicked connection's durable membership row so
   * the user does not auto-rejoin on reconnect. Defaults to `false` (boot now,
   * rejoin later). A no-op per connection when the channel is ephemeral —
   * there is no durable row to drop either way.
   */
  revoke?: boolean;
}

export interface RemoveStoredMemberOptions {
  userId: string;
  channelName: string;
  channelFamily: string | null;
  /** `true` drops the row; `false` marks it kicked so the user still rejoins later. */
  revoke: boolean;
}

/**
 * End the membership of a user who is a stored member of a persistent channel
 * but has no live connection in it. There is no socket, so no `__kicked__` and
 * no leave hooks. Peers get `__memberLeave__` unless an earlier kick already
 * removed the member. A no-op while the user has a live connection in the
 * channel, since that connection keeps the membership.
 */
export function removeStoredMember(
  runtime: Pick<
    ChannelRuntime,
    | 'channelMembers'
    | 'getDurableMembership'
    | 'deleteDurableMembership'
    | 'markDurableMembershipKicked'
    | 'clearInbox'
    | 'broadcastToChannel'
  >,
  opts: RemoveStoredMemberOptions,
): void {
  const { userId, channelName, channelFamily, revoke } = opts;
  if (userId === '') return;

  const members = runtime.channelMembers.get(
    createChannelMembershipKey(channelName, channelFamily),
  );
  for (const member of members ?? []) {
    if (member.userId === userId) return;
  }

  const stored = runtime.getDurableMembership(userId, channelName, channelFamily);
  if (!stored) return;

  if (revoke) {
    runtime.deleteDurableMembership(userId, channelName, channelFamily);
    runtime.clearInbox?.(userId, channelName, channelFamily);
  } else {
    runtime.markDurableMembershipKicked(userId, channelName, channelFamily);
  }

  if (stored.kicked) return;

  runtime.broadcastToChannel({
    channelName,
    event: '__memberLeave__',
    payload: { memberId: userId, meta: stored.meta },
    excludeConnectionId: undefined,
    channelFamily,
  });
}

/** A `UserRef` kick also reaches the user's stored membership when no tab is live. */
function kickStoredMember(runtime: ChannelRuntime, opts: KickChannelMembersOptions): void {
  const { channelName, channelFamily, target, revoke = false } = opts;
  if (target.__livething !== 'user-ref') return;

  const channel = resolveCompiledChannel(runtime.compiled, channelName, channelFamily);
  if (!channel || !runtime.isChannelDurable(channel.key)) return;

  removeStoredMember(runtime, { userId: target.id, channelName, channelFamily, revoke });
}

export async function kickChannelMembers(
  runtime: ChannelRuntime & {
    leaveChannel(connection: RuntimeConnection, opts: LeaveChannelOptions): Promise<void>;
  },
  opts: KickChannelMembersOptions,
): Promise<void> {
  const { channelName, target, reason, channelFamily, revoke = false } = opts;
  const targetKey = createChannelMembershipKey(channelName, channelFamily);
  kickStoredMember(runtime, opts);

  const pending: Promise<void>[] = [];
  // Snapshot before iterating — members can leave while this loop runs.
  // If two kicks target the same member at once, the second leave is a no-op.
  for (const connection of [...(runtime.channelMembers.get(targetKey) ?? [])]) {
    if (!matchesKickTarget(connection, target)) continue;

    const membership = connection.channelMemberships.get(targetKey);
    if (!membership) continue;

    const channel = resolveCompiledChannel(
      runtime.compiled,
      membership.channelName,
      membership.channelFamily,
    );

    pending.push(
      runtime.leaveChannel(connection, {
        channel,
        channelName: membership.channelName,
        channelFamily: membership.channelFamily,
        kickedReason: reason,
        keepDurableRow: !revoke,
      }),
    );
  }

  const failures = (await Promise.allSettled(pending)).flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `[livething] kick from channel "${channelName}" failed for ${failures.length} connection(s)`,
    );
  }
}
