/* oxlint-disable @typescript-eslint/no-explicit-any */
import { ChannelNotFound, ChannelNotSubscribed, rethrowIfConfigError } from '@wskit/core';
import { stripProtocolFields, validateValue } from '~/_engine/compile/utils.ts';
import type { CompiledChannel } from '~/_engine/compile/types.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ConnectionInfo } from '~/index.ts';

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

/** Record that a connection has joined a channel. */
export function addChannelMembership(
  connection: Pick<RuntimeConnection, 'channelMemberships'>,
  channelName: string,
  channelScope: string | null,
): void {
  connection.channelMemberships.set(createChannelMembershipKey(channelName, channelScope), {
    channelName,
    channelScope,
  });
}

/** Check whether a connection is currently subscribed to a channel. */
export function hasChannelMembership(
  connection: Pick<RuntimeConnection, 'channelMemberships'>,
  channelName: string,
  channelScope: string | null,
): boolean {
  return connection.channelMemberships.has(createChannelMembershipKey(channelName, channelScope));
}

/** Remove a connection's subscription to a channel. */
export function removeChannelMembership(
  connection: Pick<RuntimeConnection, 'channelMemberships'>,
  channelName: string,
  channelScope: string | null,
): void {
  connection.channelMemberships.delete(createChannelMembershipKey(channelName, channelScope));
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
  beforeSubscribeHooks: ReadonlyMap<
    string,
    readonly { handler: (ctx: any, data?: unknown) => void | Promise<void>; validator?: unknown }[]
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
    event: string,
    payload: Record<string, unknown>,
  ): void;
  broadcastToChannel(
    channelName: string,
    event: string,
    payload: unknown,
    excludeConnectionId: string | undefined,
    channelScope: string | null,
    excludeSelf?: boolean,
  ): void;
  handleValidationError(
    connection: RuntimeConnection,
    event: string,
    validationError: unknown,
    scope?: { channel?: CompiledChannel; channelName?: string; channelScope?: string | null },
  ): Promise<void>;
  handleRuntimeError(
    connection: RuntimeConnection,
    error: unknown,
    event?: string,
    routing?: Record<string, unknown>,
  ): Promise<void>;
  logger?: { error(message: string, fields?: Record<string, unknown>): void };
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
   * leave (client `_unsubscribe`, `removeMember`, kick) of a persistent
   * channel. Disconnect path skips this so the user stays in the group across
   * reconnects.
   */
  deleteDurableMembership(identity: string, channelName: string, channelScope: string | null): void;
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

function getChannelMembersByScope(
  runtime: Pick<ChannelRuntime, 'connections' | 'toConnectionInfo'>,
  channelName: string,
  channelScope: string | null,
): ConnectionInfo<Record<string, unknown>>[] {
  const membershipKey = createChannelMembershipKey(channelName, channelScope);
  return [...runtime.connections.values()]
    .filter((connection) => connection.channelMemberships.has(membershipKey))
    .map((connection) => runtime.toConnectionInfo(connection));
}

function resolveChannel(
  runtime: Pick<ChannelRuntime, 'compiled'>,
  payload: Record<string, unknown>,
): ResolvedChannelScope | undefined {
  if (typeof payload._channel !== 'string') return;

  const channelScope: string | null =
    typeof payload._channelScope === 'string' ? payload._channelScope : null;
  const channel =
    channelScope === null
      ? runtime.compiled.channels.get(payload._channel)
      : runtime.compiled.channelFamilies.get(channelScope);

  if (!channel) return;
  if (!matchesScopePattern(channel.pattern, payload._channel)) return;

  return {
    channel,
    channelName: payload._channel,
    channelScope,
  };
}

/**
 * Leave a channel, run channel lifecycle hooks, and notify remaining members.
 */
export async function leaveChannel(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  scope: ChannelScope,
  kickedReason?: string,
  // Pass `disconnect: true` from the socket-close path. On a persistent
  // channel this keeps the durable row, skips `onUnsubscribe`, and emits
  // only `_memberOffline`. Ephemeral channels treat any close as a true
  // leave because no durable row exists.
  disconnect?: boolean,
): Promise<void> {
  if (!hasChannelMembership(connection, scope.channelName, scope.channelScope)) return;

  const ctx = runtime.buildConnectionContext(connection, scope);
  const channelKey = scope.channel?.key ?? '';
  const isPersistent = scope.channel ? runtime.isChannelPersistent(scope.channel.key) : false;
  // Plain disconnect on a persistent channel ends the session only. Every
  // other path (unsubscribe, kick, removeMember, ephemeral disconnect)
  // changes group membership too.
  const isTrueLeave = !disconnect || !isPersistent;

  // Capture the first hook throw and re-throw at the end so the rest of
  // the leave (membership removal, broadcasts, session-end hooks) still
  // runs. Callers like kick/unsubscribe still see the rejection.
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

  removeChannelMembership(connection, scope.channelName, scope.channelScope);
  runtime.persistAttachment(connection);

  if (isTrueLeave && isPersistent) {
    runtime.deleteDurableMembership(connection.identity, scope.channelName, scope.channelScope);
  }

  if (kickedReason) {
    runtime.sendProtocolMessage(connection, '_kicked', {
      _channel: scope.channelName,
      ...(scope.channelScope !== null ? { _channelScope: scope.channelScope } : {}),
      reason: kickedReason,
    });
  }

  // Order: _memberLeave first, _memberOffline second — peers update the
  // members list before reacting to the presence change.
  if (isTrueLeave) {
    runtime.broadcastToChannel(
      scope.channelName,
      '_memberLeave',
      { connectionId: connection.id },
      connection.id,
      scope.channelScope,
    );
  }

  runtime.broadcastToChannel(
    scope.channelName,
    '_memberOffline',
    { connectionId: connection.id },
    connection.id,
    scope.channelScope,
  );

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
 * Run the gate + commit + notify flow that brings a connection into a channel.
 * Shared by the client-initiated wire path (`_subscribe`) and the server-side
 * `channelHandle.subscribe(ref)` primitive — both end up here once the channel
 * scope is resolved and the subscribe payload is in hand.
 *
 * `source` is stamped on the outgoing `_subscribeOk` so the client SDK can tell
 * whether the subscribe came from its own request (`'client'`) or from the
 * server (`'server'`) without correlating against a pending Promise.
 */
async function runSubscribeFlow(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  scope: ResolvedChannelScope,
  data: unknown,
  source: 'client' | 'server',
  // Pass `rejoining: true` when restoring a fresh socket's session for an
  // identity that's already a group member. Suppresses the `_memberJoin`
  // peer broadcast (membership didn't change) while still firing
  // `_memberOnline` for presence.
  rejoining = false,
): Promise<void> {
  const ctx = runtime.buildConnectionContext(connection, scope);

  for (const hook of runtime.beforeSubscribeHooks.get(scope.channel.key) ?? []) {
    let validatedData: unknown = data;

    if (hook.validator) {
      try {
        validatedData = validateValue(hook.validator, data, '_subscribe');
      } catch (error) {
        rethrowIfConfigError(error);
        await runtime.handleValidationError(connection, '_subscribe', error, scope);
        throw error;
      }
    }

    await hook.handler(ctx, validatedData);
  }

  // Commit membership before snapshotting the existing member list. Two
  // concurrent subscribes with an awaited onBeforeSubscribe hook would
  // otherwise both snapshot empty (neither has committed yet), then
  // both commit, and each connection sees an empty initial sync — A's
  // view excludes B and B's view excludes A. Committing first means
  // every newly subscribed connection sees the same membership view
  // that was committed when its addChannelMembership ran.
  addChannelMembership(connection, scope.channelName, scope.channelScope);
  runtime.persistAttachment(connection);

  if (runtime.isChannelPersistent(scope.channel.key)) {
    runtime.persistMembership(connection.identity, scope.channelName, scope.channelScope);
  }

  // Pass the scope so the _memberJoin syncs only include connections
  // that joined this same scope, not connections in a different family
  // that happen to use the same concrete channel name. Filter self out
  // so the client doesn't get a redundant _memberJoin for itself.
  const existingMembers = getChannelMembersByScope(
    runtime,
    scope.channelName,
    scope.channelScope,
  ).filter((member) => member.id !== connection.id);

  // Confirm the subscribe and run the member-sync protocol BEFORE any
  // user-provided onSubscribe side effects. The onBeforeSubscribe loop
  // above is the gate that decides whether the client joins; once the
  // gate has passed and membership is committed, the client must hear
  // the confirmation regardless of whether a side-effect hook later
  // throws. A throw inside onSubscribe is treated as observational and
  // routed through the runtime-error path with the channel routing
  // markers, so the client receives a separate _error frame addressed
  // to the channel scope while the subscription itself stays valid.
  runtime.sendProtocolMessage(connection, '_subscribeOk', {
    _channel: scope.channelName,
    ...(scope.channelScope !== null ? { _channelScope: scope.channelScope } : {}),
    source,
  });

  // Send one _memberJoin + one _memberOnline per existing peer so the new
  // socket has both the group-membership view and the live-presence view
  // in one round-trip.
  for (const member of existingMembers) {
    runtime.sendProtocolMessage(connection, '_memberJoin', {
      _channel: scope.channelName,
      ...(scope.channelScope !== null ? { _channelScope: scope.channelScope } : {}),
      connectionId: member.id,
      meta: member.meta,
    });
    runtime.sendProtocolMessage(connection, '_memberOnline', {
      _channel: scope.channelName,
      ...(scope.channelScope !== null ? { _channelScope: scope.channelScope } : {}),
      connectionId: member.id,
    });
  }

  // Order: _memberJoin first (group changed), then _memberOnline
  // (presence changed). Auto-rejoin skips _memberJoin because the user
  // was already a member.
  if (!rejoining) {
    runtime.broadcastToChannel(
      scope.channelName,
      '_memberJoin',
      {
        connectionId: connection.id,
        meta: connection.meta,
      },
      connection.id,
      scope.channelScope,
    );
  }

  runtime.broadcastToChannel(
    scope.channelName,
    '_memberOnline',
    {
      connectionId: connection.id,
      meta: connection.meta,
    },
    connection.id,
    scope.channelScope,
  );

  for (const hook of runtime.subscribeHooks.get(scope.channel.key) ?? []) {
    try {
      await hook(ctx);
    } catch (error) {
      const routing: Record<string, unknown> = { _channel: scope.channelName };
      if (scope.channelScope !== null) routing._channelScope = scope.channelScope;
      await runtime.handleRuntimeError(connection, error, '_subscribe', routing);
      return;
    }
  }
}

/**
 * Subscribe one connection to a channel and emit the protocol events that
 * bring it into sync with the current member list. Entry point for the
 * client-initiated path — invoked when a `_subscribe` frame arrives.
 */
export async function subscribeConnection(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  payload: Record<string, unknown> | undefined,
): Promise<void> {
  if (!payload) return;

  const scope = resolveChannel(runtime, payload);
  if (!scope) {
    throw ChannelNotFound();
  }

  const data = stripProtocolFields(payload);
  await runSubscribeFlow(runtime, connection, scope, data, 'client');
}

/**
 * Server-initiated subscribe. Invoked by `channelHandle.subscribe(ref, payload?)`
 * to add a connection to a channel without a wire frame.
 *
 * Resolves to a no-op when the connection is already a member of the target
 * channel scope — calling subscribe on an existing membership is treated as
 * "make sure they are in", not as a re-subscribe. The wire-level no-op means
 * no extra `_subscribeOk` and no extra `_memberJoin` reach the client.
 */
export async function subscribeConnectionAsServer(
  runtime: ChannelRuntime,
  connection: RuntimeConnection,
  channelName: string,
  channelScope: string | null,
  payload: unknown,
  rejoining = false,
): Promise<void> {
  const channel = resolveCompiledChannel(runtime.compiled, channelName, channelScope);
  if (!channel || !matchesScopePattern(channel.pattern, channelName)) {
    throw ChannelNotFound();
  }

  if (hasChannelMembership(connection, channelName, channelScope)) return;

  await runSubscribeFlow(
    runtime,
    connection,
    { channel, channelName, channelScope },
    payload,
    'server',
    rejoining,
  );
}

/**
 * Unsubscribe one connection from a channel by delegating to the shared leave
 * helper.
 */
export async function unsubscribeConnection(
  runtime: ChannelRuntime & {
    leaveChannel(
      connection: RuntimeConnection,
      scope: ChannelScope,
      kickedReason?: string,
    ): Promise<void>;
  },
  connection: RuntimeConnection,
  payload: Record<string, unknown> | undefined,
): Promise<void> {
  if (!payload) return;

  const scope = resolveChannel(runtime, payload);
  if (!scope) {
    throw ChannelNotFound();
  }

  if (!hasChannelMembership(connection, scope.channelName, scope.channelScope)) {
    throw ChannelNotSubscribed();
  }

  await runtime.leaveChannel(connection, scope);
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
export async function kickChannelMembers(
  runtime: ChannelRuntime & {
    leaveChannel(
      connection: RuntimeConnection,
      scope: ChannelScope,
      kickedReason?: string,
    ): Promise<void>;
  },
  channelName: string,
  tag: string,
  reason: string,
  channelScope: string | null,
): Promise<void> {
  const targetKey = createChannelMembershipKey(channelName, channelScope);
  const pending: Promise<void>[] = [];
  for (const connection of runtime.connections.values()) {
    if (!connection.tags.has(tag)) continue;

    const membership = connection.channelMemberships.get(targetKey);
    if (!membership) continue;

    const channel = resolveCompiledChannel(
      runtime.compiled,
      membership.channelName,
      membership.channelScope,
    );

    pending.push(
      runtime
        .leaveChannel(
          connection,
          {
            channel,
            channelName: membership.channelName,
            channelScope: membership.channelScope,
          },
          reason,
        )
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
