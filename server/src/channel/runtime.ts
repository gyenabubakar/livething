/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  ChannelNotFound,
  ChannelNotSubscribed,
  RejoinRejected,
  rethrowIfConfigError,
  WSKitConfigError,
} from '@wskit/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import { userKeyOf } from '~/_engine/runtime/user-key.ts';
import type { CompiledChannel } from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ChannelHooks, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ConnectionInfo, Logger } from '~/context.ts';
import type { NotifyValidationErrorOptions, SendRuntimeErrorOptions } from '~/errors/runtime.ts';

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
    scope?: { channel?: CompiledChannel; channelName?: string; channelFamily?: string | null },
  ): Record<PropertyKey, unknown>;

  persistAttachment(connection: RuntimeConnection): void;

  sendProtocolMessage(
    connection: RuntimeConnection,
    opts: { event: string; payload: Record<string, unknown>; wskit: Record<string, unknown> },
  ): void;

  broadcastToChannel(opts: BroadcastToChannelOptions): void;

  handleValidationError(
    connection: RuntimeConnection,
    opts: NotifyValidationErrorOptions,
  ): Promise<void>;

  handleRuntimeError(connection: RuntimeConnection, opts: SendRuntimeErrorOptions): Promise<void>;

  logger?: Pick<Logger, 'error'>;

  /**
   * Whether the given channel-key should write durable memberships. Returns
   * `false` when persistence is disabled at the server level OR the channel
   * set `persistent: false` in its definition. The runtime gates every
   * persistence write through this so persistence-disabled servers pay no SQL cost.
   */
  isChannelPersistent(channelKey: string): boolean;

  /**
   * Insert or replace a durable membership row for the given user. Called
   * after a successful subscribe to a persistent channel. No-op when the
   * channel is not persistent.
   */
  persistMembership(userId: string, channelName: string, channelFamily: string | null): void;

  /**
   * Delete a durable membership row for the given user. Called on a TRUE
   * leave (client `__unsubscribe__`, revoking `kick`) of a persistent
   * channel. Disconnect path skips this so the user stays in the group across
   * reconnects.
   */
  deleteDurableMembership(userId: string, channelName: string, channelFamily: string | null): void;

  hasDurableMembership(userId: string, channelName: string, channelFamily: string | null): boolean;

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
 * `__subscribe__` / `__unsubscribe__` frame carried on its `__wskit` block.
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

/** Build the `__wskit` routing block for a channel-scoped protocol frame. */
function buildChannelRouting(scope: ChannelTarget): Record<string, unknown> {
  const wskit: Record<string, unknown> = { channel: scope.channelName };
  if (scope.channelFamily !== null) wskit.channelFamily = scope.channelFamily;
  return wskit;
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
   * the user auto-rejoins the channel on their next reconnect. Set by a
   * non-revoking `kick`. Ignored on a plain disconnect, which already keeps
   * the row via `disconnect`.
   */
  keepDurableRow?: boolean;
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
  const isPersistent = scope.channel ? runtime.isChannelPersistent(scope.channel.key) : disconnect;

  // A disconnect on a persistent channel only ends the session. Every other
  // path also changes group membership.
  const isTrueLeave = !disconnect || !isPersistent;

  // Remove membership before running any async hooks. A concurrent leave
  // will see the member already gone and stop early.
  removeChannelMembership(runtime.channelMembers, connection, scope);
  runtime.persistAttachment(connection);

  if (isTrueLeave && (isPersistent || !scope.channel) && !keepDurableRow) {
    runtime.deleteDurableMembership(connection.userId, scope.channelName, scope.channelFamily);
    if (connection.userId) {
      runtime.clearInbox?.(connection.userId, scope.channelName, scope.channelFamily);
    }
  }

  // Hold the first hook throw and re-throw at the end so the rest of the leave
  // still runs. Callers still see the rejection.
  let firstHookError: unknown;
  if (isTrueLeave) {
    for (const hook of runtime.unsubscribeHooks.get(channelKey) ?? []) {
      try {
        await hook(ctx);
      } catch (error) {
        runtime.logger?.error('[wskit] onUnsubscribe hook threw', {
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
      wskit: buildChannelRouting(scope),
    });
  }

  // Order: __memberLeave__ before __memberOffline__ — peers update the member
  // list before reacting to the presence change.
  if (isTrueLeave) {
    runtime.broadcastToChannel({
      channelName: scope.channelName,
      event: '__memberLeave__',
      payload: { connectionId: connection.id, meta: connection.meta },
      excludeConnectionId: connection.id,
      channelFamily: scope.channelFamily,
    });
  }

  runtime.broadcastToChannel({
    channelName: scope.channelName,
    event: '__memberOffline__',
    payload: { connectionId: connection.id },
    excludeConnectionId: connection.id,
    channelFamily: scope.channelFamily,
  });

  for (const hook of runtime.sessionEndHooks.get(channelKey) ?? []) {
    try {
      await hook(ctx);
    } catch (error) {
      runtime.logger?.error('[wskit] onSessionEnd hook threw', {
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

  /** Restores a fresh socket for an existing member. Skips `__memberJoin__` but fires `__memberOnline__`. */
  rejoining?: boolean;
}

async function runSubscribeFlow(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  opts: RunSubscribeFlowOptions,
): Promise<void> {
  const { data, source, rejoining = false } = opts;
  const scope: ResolvedChannelTarget = opts;

  if (!rejoining && hasChannelMembership(connection, scope.channelName, scope.channelFamily)) {
    return;
  }

  const ctx = runtime.buildConnectionContext(connection, scope);

  // First subscribe runs `check` with the subscribe payload. Auto-rejoin runs
  // `revalidate` instead — no payload, revocation only — so a payload-gated
  // `check` is never handed an undefined payload on reconnect.
  let checkResult: unknown;
  if (rejoining) {
    const revalidateHook = runtime.revalidateHooks.get(scope.channel.key)?.[0];
    if (revalidateHook) {
      try {
        await revalidateHook(ctx);
      } catch (error) {
        // A config error is a framework misconfig, not a revocation — let it
        // propagate so auto-rejoin keeps the membership instead of dropping it.
        rethrowIfConfigError(error);
        // Any other throw is the gate revoking access. Normalize it so the
        // auto-rejoin catch can tell a revoke apart from a storage/internal
        // failure and only drop the durable row for a real revoke.
        throw RejoinRejected({
          message: error instanceof Error ? error.message : String(error),
        });
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
      checkResult = await checkHook.handler(ctx, validatedData);
    }
  }

  if (!rejoining && hasChannelMembership(connection, scope.channelName, scope.channelFamily)) {
    return;
  }

  const isPersistent = runtime.isChannelPersistent(scope.channel.key);

  // Re-check durable membership here — a leave that finished after phase 1
  // may have already cleared the row.
  if (
    rejoining &&
    isPersistent &&
    !runtime.hasDurableMembership(connection.userId, scope.channelName, scope.channelFamily)
  ) {
    return;
  }

  // commit is the first-subscribe capacity/final gate. Auto-rejoin skips it — a
  // returning member already holds a seat and must not be re-counted against a
  // cap that filled while they were away.
  if (!rejoining) {
    const commitHook = runtime.commitHooks.get(scope.channel.key)?.[0];
    if (commitHook) {
      const r: unknown = commitHook.handler(ctx, checkResult);
      // Detect any thenable — a native Promise, a cross-realm Promise, or a
      // custom `{ then() {} }` — not just `instanceof Promise`. An async-like
      // commit must fail before membership is written.
      if (
        r !== null &&
        (typeof r === 'object' || typeof r === 'function') &&
        typeof (r as { then?: unknown }).then === 'function'
      ) {
        throw new WSKitConfigError('[wskit] commit() must be synchronous.');
      }
    }
  }

  // Write the durable membership row first. If the SQL write throws, the
  // connection must not already be a live member of a channel it was never
  // saved into.
  if (isPersistent) {
    runtime.persistMembership(connection.userId, scope.channelName, scope.channelFamily);
  }

  // Commit live membership before snapshotting the member list. Otherwise two
  // concurrent subscribes both snapshot empty and miss each other.
  addChannelMembership(runtime.channelMembers, connection, scope);

  runtime.persistAttachment(connection);

  const members = snapshotMembers(runtime, scope, connection.id);

  const wskit = buildChannelRouting(scope);

  // Send confirmation before running onSubscribe, so a throwing hook cannot
  // delay or block it from reaching the client. The persistent flag tells the
  // client to leave this channel to server-driven auto-rejoin on reconnect
  // rather than re-subscribing it itself. The inbox flag tells the client to ack
  // this channel's messages (and only inbox channels) with `__received__`.
  const confirmation: Record<string, unknown> = {
    ...wskit,
    source,
    channelPersistent: isPersistent,
  };
  if (runtime.isInboxChannel?.(scope.channelName, scope.channelFamily)) {
    confirmation.inbox = true;
  }
  if (runtime.isReadReceiptsChannel?.(scope.channelName, scope.channelFamily)) {
    confirmation.readReceipts = true;
  }
  runtime.sendProtocolMessage(connection, {
    event: '__subscribeOk__',
    payload: {},
    wskit: confirmation,
  });

  runtime.sendProtocolMessage(connection, {
    event: '__memberSync__',
    payload: { members },
    wskit: { ...wskit, source },
  });

  // Order: __memberJoin__ (group changed) before __memberOnline__ (presence).
  // Rejoin skips __memberJoin__ — the user was already a member.
  if (!rejoining) {
    runtime.broadcastToChannel({
      channelName: scope.channelName,
      event: '__memberJoin__',
      payload: { connectionId: connection.id, meta: connection.meta },
      excludeConnectionId: connection.id,
      channelFamily: scope.channelFamily,
    });
  }

  runtime.broadcastToChannel({
    channelName: scope.channelName,
    event: '__memberOnline__',
    payload: { connectionId: connection.id, meta: connection.meta },
    excludeConnectionId: connection.id,
    channelFamily: scope.channelFamily,
  });

  // Auto-rejoin does not fire onSubscribe — the user already joined once, and
  // the rejoin only restores a fresh socket. Re-running join side-effects (a
  // welcome push, a "X joined" broadcast) on every reconnect would be wrong.
  if (!rejoining) {
    for (const hook of runtime.subscribeHooks.get(scope.channel.key) ?? []) {
      try {
        await hook(ctx);
      } catch (error) {
        const routing: Protocol.WSKitRouting = { channel: scope.channelName };
        if (scope.channelFamily !== null) routing.channelFamily = scope.channelFamily;
        await runtime.handleRuntimeError(connection, { error, event: '__subscribe__', routing });
        return;
      }
    }
  }
}

/** Build the public member snapshot for a channel, excluding the given connection. */
function snapshotMembers(
  runtime: Pick<ChannelRuntime, 'channelMembers'>,
  scope: ChannelTarget,
  excludeConnectionId: string,
): { connectionId: string; meta: Record<string, unknown> }[] {
  const memberKey = createChannelMembershipKey(scope.channelName, scope.channelFamily);
  const members: { connectionId: string; meta: Record<string, unknown> }[] = [];
  for (const member of runtime.channelMembers.get(memberKey) ?? []) {
    if (member.id !== excludeConnectionId) {
      members.push({ connectionId: member.id, meta: member.meta });
    }
  }
  return members;
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
  runtime: Pick<ChannelRuntime, 'compiled' | 'channelMembers' | 'sendProtocolMessage'>,
  connection: RuntimeConnection,
  opts: ResyncMembersOptions,
): void {
  const scope = resolveChannelByName(runtime, opts.channelName, opts.channelFamily);
  if (!scope) return;
  if (!hasChannelMembership(connection, scope.channelName, scope.channelFamily)) return;

  const members = snapshotMembers(runtime, scope, connection.id);
  runtime.sendProtocolMessage(connection, {
    event: '__memberSync__',
    payload: { members },
    wskit: { ...buildChannelRouting(scope), source: 'server' },
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
 * non-member keeps the legacy `ChannelNotSubscribed` error — the reliable client
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
      wskit: { ...buildChannelRouting(scope), unsubscribeId: opts.unsubscribeId },
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
 * - `{ __wskit: 'group-handle', kind, group }` — kick every socket with any
 *   key under this `(kind, group)`.
 *
 * To drop one specific socket without kicking the rest of its user's
 * connections, callers use `ctx.connections.get(ref).close()` instead.
 */
export type KickTarget =
  | { __wskit: 'user-ref'; id: string; instance: string | undefined }
  | { __wskit: 'tag-ref'; kind: 'ephemeral' | 'persistent'; group: string; key: string }
  | { __wskit: 'group-handle'; kind: 'ephemeral' | 'persistent'; group: string };

function matchesKickTarget(connection: RuntimeConnection, target: KickTarget): boolean {
  if (target.__wskit === 'user-ref') return userKeyOf(connection) === target.id;
  if (target.__wskit === 'tag-ref') {
    return connection.tags[target.kind].get(target.group)?.has(target.key) ?? false;
  }
  return (connection.tags[target.kind].get(target.group)?.size ?? 0) > 0;
}

/**
 * A channel-scoped `send`/`request` recipient: a specific socket
 * (`ConnectionRef`), a whole user (`UserRef`), or a tag / tag group. Everything
 * except a `ConnectionRef` is intersected with channel membership.
 */
export type ChannelRecipient =
  | { __wskit: 'connection-ref'; id: string; instance: string | undefined; userId: string }
  | KickTarget;

/** Whether a connection satisfies a channel-scoped recipient. */
export function matchesRecipient(connection: RuntimeConnection, target: ChannelRecipient): boolean {
  if (target.__wskit === 'connection-ref') return connection.id === target.id;
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
 * Every triggered `leaveChannel` runs to completion. `onUnsubscribe` hook
 * failures are logged through `runtime.logger` and do not cancel the rest
 * of the kick — the same shape the engine uses during shutdown drain.
 */
export interface KickChannelMembersOptions {
  channelName: string;

  target: KickTarget;

  reason: string;

  channelFamily: string | null;

  /**
   * When true, also delete each kicked connection's durable membership row so
   * the user does not auto-rejoin on reconnect. Defaults to `false` (boot now,
   * rejoin later). A no-op per connection when persistence is off or the
   * channel is ephemeral — there is no durable row to drop either way.
   */
  revoke?: boolean;
}

export async function kickChannelMembers(
  runtime: ChannelRuntime & {
    leaveChannel(connection: RuntimeConnection, opts: LeaveChannelOptions): Promise<void>;
  },
  opts: KickChannelMembersOptions,
): Promise<void> {
  const { channelName, target, reason, channelFamily, revoke = false } = opts;
  const targetKey = createChannelMembershipKey(channelName, channelFamily);
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
      runtime
        .leaveChannel(connection, {
          channel,
          channelName: membership.channelName,
          channelFamily: membership.channelFamily,
          kickedReason: reason,
          keepDurableRow: !revoke,
        })
        .catch((error) => {
          runtime.logger?.error('[wskit] leaveChannel threw during kick', {
            channelName: membership.channelName,
            channelFamily: membership.channelFamily,
            connectionId: connection.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  }
  await Promise.all(pending);
}
