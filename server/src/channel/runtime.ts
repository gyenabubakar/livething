/* oxlint-disable @typescript-eslint/no-explicit-any */
import { ChannelNotFound, ChannelNotSubscribed, rethrowIfConfigError } from '@wskit/core';
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
   * called `.persistent(false)`. The runtime gates every persistence write
   * through this so persistence-disabled servers pay no SQL cost.
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
function channelWskit(scope: ChannelScope): Record<string, unknown> {
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
  const isPersistent = scope.channel ? runtime.isChannelPersistent(scope.channel.key) : false;
  // A disconnect on a persistent channel only ends the session. Every other
  // path also changes group membership.
  const isTrueLeave = !disconnect || !isPersistent;

  // Remove membership before running any async hooks. A concurrent leave
  // will see the member already gone and stop early.
  removeChannelMembership(runtime.channelMembers, connection, scope);
  runtime.persistAttachment(connection);

  if (isTrueLeave && isPersistent) {
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
      wskit: channelWskit(scope),
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

  // ── Phase 1: check (async, concurrent) ───────────────────────────────────
  let checkResult: unknown;
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

  // ── Phase 2: commit then membership write ────────────────────────────────
  // Re-check durable membership here — a leave that finished after phase 1
  // may have already cleared the row.
  if (
    rejoining &&
    runtime.isChannelPersistent(scope.channel.key) &&
    !runtime.hasDurableMembership(connection.identity, scope.channelName, scope.channelScope)
  ) {
    return;
  }

  const commitHook = runtime.commitHooks.get(scope.channel.key)?.[0];
  if (commitHook) {
    const r: unknown = commitHook.handler(ctx, checkResult);
    if (r instanceof Promise) {
      throw new Error(
        '[wskit] commit() must be synchronous. Remove the async keyword from your commit handler.',
      );
    }
  }

  // Commit membership before snapshotting the member list. Otherwise two
  // concurrent subscribes both snapshot empty and miss each other.
  addChannelMembership(runtime.channelMembers, connection, scope);

  // ── Phase 3: post-commit (async) ─────────────────────────────────────────
  runtime.persistAttachment(connection);

  if (runtime.isChannelPersistent(scope.channel.key)) {
    runtime.persistMembership(connection.identity, scope.channelName, scope.channelScope);
  }

  // Snapshot the members of this exact scope, self excluded, straight from
  // the index — no throwaway ConnectionInfo objects.
  const memberKey = createChannelMembershipKey(scope.channelName, scope.channelScope);
  const members: { connectionId: string; meta: Record<string, unknown> }[] = [];
  for (const member of runtime.channelMembers.get(memberKey) ?? []) {
    if (member.id !== connection.id) {
      members.push({ connectionId: member.id, meta: member.meta });
    }
  }

  const wskit = channelWskit(scope);

  // Send confirmation before running onSubscribe, so a throwing hook cannot
  // delay or block it from reaching the client.
  runtime.sendProtocolMessage(connection, { event: '__subscribeOk__', payload: { source }, wskit });

  // One snapshot frame with the whole member list, in place of a
  // __memberJoin__ + __memberOnline__ pair per existing peer.
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

  for (const hook of runtime.subscribeHooks.get(scope.channel.key) ?? []) {
    try {
      await hook(ctx);
    } catch (error) {
      const routing: Protocol.WskitRouting = { channel: scope.channelName };
      if (scope.channelScope !== null) routing.channelScope = scope.channelScope;
      await runtime.handleRuntimeError(connection, { error, event: '__subscribe__', routing });
      return;
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

/**
 * Unsubscribe one connection from a channel by delegating to the shared leave
 * helper.
 */
export async function unsubscribeConnection(
  runtime: ChannelRuntime & {
    leaveChannel(connection: RuntimeConnection, opts: LeaveChannelOptions): Promise<void>;
  },
  connection: RuntimeConnection,
  membership: ChannelMembership,
): Promise<void> {
  const scope = resolveChannelByName(runtime, membership.channelName, membership.channelScope);
  if (!scope) {
    throw ChannelNotFound();
  }

  if (!hasChannelMembership(connection, scope.channelName, scope.channelScope)) {
    throw ChannelNotSubscribed();
  }
  await runtime.leaveChannel(connection, scope);
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
