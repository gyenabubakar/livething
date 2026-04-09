/* oxlint-disable @typescript-eslint/no-explicit-any */
import { validateValue } from '~/_engine/compile/utils.ts';
import type { CompiledChannel } from '~/_engine/compile/types.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ConnectionInfo } from '~/index.ts';

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
  if (!connection.channels.has(scope.channelName)) return;

  const ctx = runtime.buildConnectionContext(connection, scope);

  for (const hook of runtime.unsubscribeHooks.get(scope.channel?.key ?? '') ?? []) {
    await hook(ctx);
  }

  connection.channels.delete(scope.channelName);
  connection.tags.delete(`channel:${scope.channelName}`);
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
  if (!scope) return;

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

  connection.channels.add(scope.channelName);
  connection.tags.add(`channel:${scope.channelName}`);
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

    const channel = runtime.compiled.channels.get(channelName);
    void runtime.leaveChannel(connection, { channel, channelName }, reason);
  }
}
