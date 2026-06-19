/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  ChannelNotFound,
  ChannelNotSubscribed,
  RejoinRejected,
  rethrowIfConfigError,
  WSKitConfigError,
} from '@wskit/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import type { CompiledChannel } from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ConnectionInfo, Logger } from '~/context.ts';
import type { NotifyValidationErrorOptions, SendRuntimeErrorOptions } from '~/errors/runtime.ts';

/**
 * Tracks which channel a connection is subscribed to.
 *
 * `channelScope` is `null` for static channels and a non-empty family key for
 * dynamic channel families. The two cases never collapse into the same shape.
 */
export interface ChannelMembership {
  channelName: string;
  channelScope: string | null;
}

/**
 * Build a unique string key from a channel name and explicit scope marker.
 * Pass `null` for static channels and the family key for dynamic families.
 */
export function createChannelMembershipKey(
  channelName: string,
  channelScope: string | null,
): string {
  return JSON.stringify([channelScope, channelName]);
}

/** Record that a connection has joined a channel, updating the member index. */
export function addChannelMembership(
  channelMembers: Map<string, Set<RuntimeConnection>>,
  connection: RuntimeConnection,
  membership: ChannelMembership,
): void {
  const key = createChannelMembershipKey(membership.channelName, membership.channelScope);
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
  channelScope: string | null,
): boolean {
  return connection.channelMemberships.has(createChannelMembershipKey(channelName, channelScope));
}

/** Remove a connection's subscription to a channel, updating the member index. */
export function removeChannelMembership(
  channelMembers: Map<string, Set<RuntimeConnection>>,
  connection: RuntimeConnection,
  membership: ChannelMembership,
): void {
  const key = createChannelMembershipKey(membership.channelName, membership.channelScope);
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
export function matchesScopePattern(
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
  channelScope: string | null,
): CompiledChannel | undefined {
  return channelScope === null
    ? compiled.channels.get(channelName)
    : compiled.channelFamilies.get(channelScope);
}

export interface BroadcastToChannelOptions {
  channelName: string;

  event: string;

  payload: unknown;

  excludeConnectionId: string | undefined;

  channelScope: string | null;

  excludeSelf?: boolean;
}

/**
 * The shared engine surface channel protocol helpers need.
 *
 * The engine keeps membership state and connection lookup. These helpers own
 * the subscribe and unsubscribe protocol behavior built on top of that state.
 */
interface ChannelRuntime {
  compiled: {
    channels: Map<string, CompiledChannel>;
    channelFamilies: Map<string, CompiledChannel>;
  };

  connections: Map<string, RuntimeConnection>;

  channelMembers: Map<string, Set<RuntimeConnection>>;

  checkHooks: ReadonlyMap<
    string,
    readonly {
      handler: (ctx: any, data?: unknown) => unknown | Promise<unknown>;
      validator?: unknown;
    }[]
  >;

  revalidateHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;

  commitHooks: ReadonlyMap<
    string,
    readonly { handler: (ctx: any, checkResult: unknown) => void }[]
  >;

  subscribeHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;

  unsubscribeHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;

  sessionEndHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;

  toConnectionInfo(connection: RuntimeConnection): ConnectionInfo<Record<string, unknown>>;

  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: { channel?: CompiledChannel; channelName?: string; channelScope?: string | null },
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
   * Insert or replace a durable membership row for the given identity. Called
   * after a successful subscribe to a persistent channel. No-op when the
   * channel is not persistent.
   */
  persistMembership(identity: string, channelName: string, channelScope: string | null): void;

  /**
   * Delete a durable membership row for the given identity. Called on a TRUE
   * leave (client `__unsubscribe__`, `removeMember`, kick) of a persistent
   * channel. Disconnect path skips this so the user stays in the group across
   * reconnects.
   */
  deleteDurableMembership(identity: string, channelName: string, channelScope: string | null): void;

  hasDurableMembership(identity: string, channelName: string, channelScope: string | null): boolean;
}

interface ChannelScope {
  channel?: CompiledChannel;
  channelName: string;
  channelScope: string | null;
}

interface ResolvedChannelScope {
  channel: CompiledChannel;
  channelName: string;
  channelScope: string | null;
}

/**
 * Resolve a compiled channel from the `channel` + `channelScope` markers a
 * `__subscribe__` / `__unsubscribe__` frame carried on its `__wskit` block.
 * Returns `undefined` when the channel does not exist or the concrete name
 * fails the family pattern.
 */
function resolveChannelByName(
  runtime: Pick<ChannelRuntime, 'compiled'>,
  channelName: string,
  channelScope: string | null,
): ResolvedChannelScope | undefined {
  const channel =
    channelScope === null
      ? runtime.compiled.channels.get(channelName)
      : runtime.compiled.channelFamilies.get(channelScope);

  if (!channel) return;
  if (!matchesScopePattern(channel.pattern, channelName)) return;

  return { channel, channelName, channelScope };
}

/** Build the `__wskit` routing block for a channel-scoped protocol frame. */
function buildChannelRouting(scope: ChannelScope): Record<string, unknown> {
  const wskit: Record<string, unknown> = { channel: scope.channelName };
  if (scope.channelScope !== null) wskit.channelScope = scope.channelScope;
  return wskit;
}

/**
 * Leave a channel, run channel lifecycle hooks, and notify remaining members.
 */
export interface LeaveChannelOptions {
  channel?: CompiledChannel;

  channelName: string;

  channelScope: string | null;

  kickedReason?: string;

  /** `true` on socket close. On a persistent channel it keeps the durable row and skips `onUnsubscribe`. */
  disconnect?: boolean;
}

export async function leaveChannel(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  opts: LeaveChannelOptions,
): Promise<void> {
  const { kickedReason, disconnect } = opts;
  const scope: ChannelScope = opts;
  if (!hasChannelMembership(connection, scope.channelName, scope.channelScope)) return;

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

  if (isTrueLeave && (isPersistent || !scope.channel)) {
    runtime.deleteDurableMembership(connection.identity, scope.channelName, scope.channelScope);
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
          channelScope: scope.channelScope,
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
      channelScope: scope.channelScope,
    });
  }

  runtime.broadcastToChannel({
    channelName: scope.channelName,
    event: '__memberOffline__',
    payload: { connectionId: connection.id },
    excludeConnectionId: connection.id,
    channelScope: scope.channelScope,
  });

  for (const hook of runtime.sessionEndHooks.get(channelKey) ?? []) {
    try {
      await hook(ctx);
    } catch (error) {
      runtime.logger?.error('[wskit] onSessionEnd hook threw', {
        connectionId: connection.id,
        channel: scope.channelName,
        channelScope: scope.channelScope,
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

  channelScope: string | null;

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
  const scope: ResolvedChannelScope = opts;
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

  if (!rejoining && hasChannelMembership(connection, scope.channelName, scope.channelScope)) {
    return;
  }

  const isPersistent = runtime.isChannelPersistent(scope.channel.key);

  // Re-check durable membership here — a leave that finished after phase 1
  // may have already cleared the row.
  if (
    rejoining &&
    isPersistent &&
    !runtime.hasDurableMembership(connection.identity, scope.channelName, scope.channelScope)
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
        throw new WSKitConfigError(
          '[wskit] commit() must be synchronous. Remove the async keyword from your commit handler.',
        );
      }
    }
  }

  // Write the durable membership row first. If the SQL write throws, the
  // connection must not already be a live member of a channel it was never
  // saved into.
  if (isPersistent) {
    runtime.persistMembership(connection.identity, scope.channelName, scope.channelScope);
  }

  // Commit live membership before snapshotting the member list. Otherwise two
  // concurrent subscribes both snapshot empty and miss each other.
  addChannelMembership(runtime.channelMembers, connection, scope);

  runtime.persistAttachment(connection);

  const memberKey = createChannelMembershipKey(scope.channelName, scope.channelScope);
  const members: { connectionId: string; meta: Record<string, unknown> }[] = [];
  for (const member of runtime.channelMembers.get(memberKey) ?? []) {
    if (member.id !== connection.id) {
      members.push({ connectionId: member.id, meta: member.meta });
    }
  }

  const wskit = buildChannelRouting(scope);

  // Send confirmation before running onSubscribe, so a throwing hook cannot
  // delay or block it from reaching the client. The persistent flag tells the
  // client to leave this channel to server-driven auto-rejoin on reconnect
  // rather than re-subscribing it itself.
  runtime.sendProtocolMessage(connection, {
    event: '__subscribeOk__',
    payload: {},
    wskit: { ...wskit, source, channelPersistent: isPersistent },
  });

  runtime.sendProtocolMessage(connection, { event: '__memberSync__', payload: { members }, wskit });

  // Order: __memberJoin__ (group changed) before __memberOnline__ (presence).
  // Rejoin skips __memberJoin__ — the user was already a member.
  if (!rejoining) {
    runtime.broadcastToChannel({
      channelName: scope.channelName,
      event: '__memberJoin__',
      payload: { connectionId: connection.id, meta: connection.meta },
      excludeConnectionId: connection.id,
      channelScope: scope.channelScope,
    });
  }

  runtime.broadcastToChannel({
    channelName: scope.channelName,
    event: '__memberOnline__',
    payload: { connectionId: connection.id, meta: connection.meta },
    excludeConnectionId: connection.id,
    channelScope: scope.channelScope,
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
        if (scope.channelScope !== null) routing.channelScope = scope.channelScope;
        await runtime.handleRuntimeError(connection, { error, event: '__subscribe__', routing });
        return;
      }
    }
  }
}

/**
 * Subscribe one connection to a channel and emit the protocol events that
 * bring it into sync with the current member list. Entry point for the
 * client-initiated path — invoked when a `__subscribe__` frame arrives.
 */
export interface SubscribeConnectionOptions {
  channelName: string;
  channelScope: string | null;
  data: unknown;
}

export async function subscribeConnection(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  opts: SubscribeConnectionOptions,
): Promise<void> {
  const scope = resolveChannelByName(runtime, opts.channelName, opts.channelScope);
  if (!scope) {
    throw ChannelNotFound();
  }

  await runSubscribeFlow(runtime, connection, { ...scope, data: opts.data, source: 'client' });
}

export interface SubscribeConnectionAsServerOptions {
  channelName: string;

  channelScope: string | null;

  payload: unknown;

  rejoining?: boolean;
}

/**
 * Server-initiated subscribe. Invoked by `channelHandle.subscribe(ref, payload?)`
 * to add a connection to a channel without a wire frame.
 *
 * Resolves to a no-op when the connection is already a member of the target
 * channel scope — calling subscribe on an existing membership is treated as
 * "make sure they are in", not as a re-subscribe. The wire-level no-op means
 * no extra `__subscribeOk__` and no extra `__memberJoin__` reach the client.
 */
export async function subscribeConnectionAsServer(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  opts: SubscribeConnectionAsServerOptions,
): Promise<void> {
  const { channelName, channelScope, payload, rejoining = false } = opts;
  const channel = resolveCompiledChannel(runtime.compiled, channelName, channelScope);
  if (!channel || !matchesScopePattern(channel.pattern, channelName)) {
    throw ChannelNotFound();
  }

  if (hasChannelMembership(connection, channelName, channelScope)) return;

  await runSubscribeFlow(runtime, connection, {
    channel,
    channelName,
    channelScope,
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
  const scope = resolveChannelByName(runtime, opts.channelName, opts.channelScope);
  if (!scope) {
    throw ChannelNotFound();
  }

  const isMember = hasChannelMembership(connection, scope.channelName, scope.channelScope);
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
 * - `ConnectionRef` — kick this exact socket.
 * - `TagRef` — kick every socket holding this `(kind, group, key)` tag.
 * - `{ __wskit: 'group-handle', kind, group }` — kick every socket with any
 *   key under this `(kind, group)`.
 */
export type KickTarget =
  | { __wskit: 'connection-ref'; id: string; instance: string | undefined; identity: string }
  | { __wskit: 'tag-ref'; kind: 'ephemeral' | 'persistent'; group: string; key: string }
  | { __wskit: 'group-handle'; kind: 'ephemeral' | 'persistent'; group: string };

function matchesKickTarget(connection: RuntimeConnection, target: KickTarget): boolean {
  if (target.__wskit === 'connection-ref') return connection.id === target.id;
  if (target.__wskit === 'tag-ref') {
    return connection.tags[target.kind].get(target.group)?.has(target.key) ?? false;
  }
  return (connection.tags[target.kind].get(target.group)?.size ?? 0) > 0;
}

/**
 * Remove tagged members from a channel, usually for moderation or access
 * control.
 *
 * Scoped to the exact `channelName + channelScope` pair: kicks never cross
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

  channelScope: string | null;
}

export async function kickChannelMembers(
  runtime: ChannelRuntime & {
    leaveChannel(connection: RuntimeConnection, opts: LeaveChannelOptions): Promise<void>;
  },
  opts: KickChannelMembersOptions,
): Promise<void> {
  const { channelName, target, reason, channelScope } = opts;
  const targetKey = createChannelMembershipKey(channelName, channelScope);
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
      membership.channelScope,
    );

    pending.push(
      runtime
        .leaveChannel(connection, {
          channel,
          channelName: membership.channelName,
          channelScope: membership.channelScope,
          kickedReason: reason,
        })
        .catch((error) => {
          runtime.logger?.error('[wskit] leaveChannel threw during kick', {
            channelName: membership.channelName,
            channelScope: membership.channelScope,
            connectionId: connection.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  }
  await Promise.all(pending);
}
