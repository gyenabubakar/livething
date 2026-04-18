/* oxlint-disable @typescript-eslint/no-explicit-any */
import { WskitError } from '@wskit/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import type { CompiledChannel } from '~/_engine/compile/types.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ConnectionInfo } from '~/index.ts';

/** Tracks which channel a connection is subscribed to, including the optional scope. */
export interface ChannelMembership {
  channelName: string;
  channelScope?: string;
}

/** Build a unique string key from a channel name and optional scope, used for membership map lookups. */
export function createChannelMembershipKey(channelName: string, channelScope?: string): string {
  return `${channelScope ?? ''}::${channelName}`;
}

/** Record that a connection has joined a channel. */
export function addChannelMembership(
  connection: Pick<RuntimeConnection, 'channels' | 'channelMemberships' | 'tags'>,
  channelName: string,
  channelScope?: string,
): void {
  connection.channels.add(channelName);
  connection.channelMemberships.set(createChannelMembershipKey(channelName, channelScope), {
    channelName,
    channelScope,
  });
  connection.tags.add(`channel:${channelName}`);
}

/** Check whether a connection is currently subscribed to a channel. */
export function hasChannelMembership(
  connection: Pick<RuntimeConnection, 'channels' | 'channelMemberships'>,
  channelName: string,
  channelScope?: string,
): boolean {
  if (connection.channelMemberships.size > 0) {
    return connection.channelMemberships.has(createChannelMembershipKey(channelName, channelScope));
  }

  return connection.channels.has(channelName);
}

/** Remove a connection's subscription to a channel. */
export function removeChannelMembership(
  connection: Pick<RuntimeConnection, 'channels' | 'channelMemberships' | 'tags'>,
  channelName: string,
  channelScope?: string,
): void {
  connection.channelMemberships.delete(createChannelMembershipKey(channelName, channelScope));

  const hasRemainingMembership = [...connection.channelMemberships.values()].some(
    (membership) => membership.channelName === channelName,
  );

  if (!hasRemainingMembership) {
    connection.channels.delete(channelName);
    connection.tags.delete(`channel:${channelName}`);
  }
}

/** Get all channel membership entries for a connection. */
export function listChannelMemberships(
  connection: Pick<RuntimeConnection, 'channelMemberships'>,
): ChannelMembership[] {
  return [...connection.channelMemberships.values()];
}

/** Look up a compiled channel definition by name, supporting both exact and pattern-based channel names. */
export function resolveCompiledChannel(
  compiled: Pick<ChannelRuntime['compiled'], 'channels' | 'channelFamilies'>,
  channelName: string,
  channelScope?: string,
): CompiledChannel | undefined {
  return channelScope
    ? compiled.channelFamilies.get(channelScope)
    : compiled.channels.get(channelName);
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
    scope?: { channel?: CompiledChannel; channelName?: string; channelScope?: string },
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
    excludeConnectionId?: string,
    channelScope?: string,
  ): void;
  handleValidationError(
    connection: RuntimeConnection,
    event: string,
    validationError: unknown,
    scope?: { channel?: CompiledChannel; channelName?: string; channelScope?: string },
  ): Promise<void>;
}

interface ChannelScope {
  channel?: CompiledChannel;
  channelName: string;
  channelScope?: string;
}

interface ResolvedChannelScope {
  channel: CompiledChannel;
  channelName: string;
  channelScope?: string;
}

function getChannelMembers(
  runtime: Pick<ChannelRuntime, 'connections' | 'toConnectionInfo'>,
  channelName: string,
): ConnectionInfo<Record<string, unknown>>[] {
  return [...runtime.connections.values()]
    .filter((connection) => connection.channels.has(channelName))
    .map((connection) => runtime.toConnectionInfo(connection));
}

function resolveChannel(
  runtime: Pick<ChannelRuntime, 'compiled'>,
  payload: Record<string, unknown>,
): ResolvedChannelScope | undefined {
  if (typeof payload._channel !== 'string') return;

  const channelScope =
    typeof payload._channelScope === 'string' ? payload._channelScope : undefined;
  const channel = channelScope
    ? runtime.compiled.channelFamilies.get(channelScope)
    : runtime.compiled.channels.get(payload._channel);

  if (!channel) return;

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

  for (const hook of runtime.unsubscribeHooks.get(scope.channel?.key ?? '') ?? []) {
    await hook(ctx);
  }

  removeChannelMembership(connection, scope.channelName, scope.channelScope);
  runtime.persistAttachment(connection);

  if (kickedReason) {
    runtime.sendProtocolMessage(connection, '_kicked', {
      _channel: scope.channelName,
      ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
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
    throw new WskitError('channel-not-found', undefined);
  }

  const existingMembers = getChannelMembers(runtime, scope.channelName);
  const ctx = runtime.buildConnectionContext(connection, scope);
  const data = { ...payload };
  delete data._channel;
  delete data._channelScope;

  for (const hook of runtime.beforeSubscribeHooks.get(scope.channel.key) ?? []) {
    let validatedData: unknown = data;

    if (hook.validator) {
      try {
        validatedData = validateValue(hook.validator, data, '_subscribe');
      } catch (error) {
        await runtime.handleValidationError(connection, '_subscribe', error, scope);
        throw error;
      }
    }

    await hook.handler(ctx, validatedData);
  }

  addChannelMembership(connection, scope.channelName, scope.channelScope);
  runtime.persistAttachment(connection);

  for (const hook of runtime.subscribeHooks.get(scope.channel.key) ?? []) {
    await hook(ctx);
  }

  runtime.sendProtocolMessage(connection, '_subscribeOk', {
    _channel: scope.channelName,
    ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
  });

  for (const member of existingMembers) {
    runtime.sendProtocolMessage(connection, '_memberJoin', {
      _channel: scope.channelName,
      ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
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
  if (!scope) return;

  await runtime.leaveChannel(connection, scope);
}

/**
 * Remove tagged members from a channel, usually for moderation or access
 * control.
 */
export function kickChannelMembers(
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
): void {
  for (const connection of runtime.connections.values()) {
    if (!connection.channels.has(channelName) || !connection.tags.has(tag)) continue;

    for (const membership of listChannelMemberships(connection)) {
      if (membership.channelName !== channelName) continue;

      const channel = resolveCompiledChannel(
        runtime.compiled,
        membership.channelName,
        membership.channelScope,
      );

      void runtime.leaveChannel(
        connection,
        {
          channel,
          channelName: membership.channelName,
          channelScope: membership.channelScope,
        },
        reason,
      );
    }
  }
}
