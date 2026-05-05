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
): Promise<void> {
  if (!hasChannelMembership(connection, scope.channelName, scope.channelScope)) return;

  const ctx = runtime.buildConnectionContext(connection, scope);

  // A user-supplied onUnsubscribe hook may throw. Run every hook so one
  // throwing hook does not skip the others, capture the first failure,
  // then unconditionally run the rest of the leave — membership removal,
  // attachment persist, _kicked notification, and the _memberLeave
  // broadcast. The captured error is re-thrown at the end so callers like
  // kickChannelMembers still observe the rejection. The close path wraps
  // its own leaveChannel calls so the re-throw does not block subsequent
  // channels from leaving during socket close.
  let firstHookError: unknown;
  for (const hook of runtime.unsubscribeHooks.get(scope.channel?.key ?? '') ?? []) {
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

  removeChannelMembership(connection, scope.channelName, scope.channelScope);
  runtime.persistAttachment(connection);

  if (kickedReason) {
    runtime.sendProtocolMessage(connection, '_kicked', {
      _channel: scope.channelName,
      ...(scope.channelScope !== null ? { _channelScope: scope.channelScope } : {}),
      reason: kickedReason,
    });
  }

  runtime.broadcastToChannel(
    scope.channelName,
    '_memberLeave',
    { connectionId: connection.id },
    connection.id,
    scope.channelScope,
  );

  if (firstHookError !== undefined) throw firstHookError;
}

/**
 * Subscribe one connection to a channel and emit the protocol events that
 * bring it into sync with the current member list.
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

  // Pass the scope so the _memberJoin syncs only include connections that
  // joined this same scope, not connections in a different family that
  // happen to use the same concrete channel name.
  const existingMembers = getChannelMembersByScope(runtime, scope.channelName, scope.channelScope);
  const ctx = runtime.buildConnectionContext(connection, scope);
  const data = stripProtocolFields(payload);

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

  addChannelMembership(connection, scope.channelName, scope.channelScope);
  runtime.persistAttachment(connection);

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
  });

  for (const member of existingMembers) {
    runtime.sendProtocolMessage(connection, '_memberJoin', {
      _channel: scope.channelName,
      ...(scope.channelScope !== null ? { _channelScope: scope.channelScope } : {}),
      connectionId: member.id,
      meta: member.meta,
    });
  }

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
 * Awaits every triggered `leaveChannel` so `onUnsubscribe` rejections
 * propagate to the caller and so the kick is observable as complete.
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
      runtime.leaveChannel(
        connection,
        {
          channel,
          channelName: membership.channelName,
          channelScope: membership.channelScope,
        },
        reason,
      ),
    );
  }
  await Promise.all(pending);
}
