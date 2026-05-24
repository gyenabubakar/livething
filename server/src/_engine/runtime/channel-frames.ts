/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as PublicApi from '~/context.ts';
import type * as EngineRuntimeTypes from './types.ts';

/**
 * Dependency bag for channel subscribe/unsubscribe helpers.
 */
interface ChannelRuntime extends EngineRuntimeTypes.ConnectionMembersRuntime {
  hasDurableMembership(identity: string, channelName: string, channelScope: string | null): boolean;
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
  buildConnectionContext(
    connection: EngineRuntimeTypes.RuntimeConnection,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Record<PropertyKey, unknown>;
  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;
  sendProtocolMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
    wskit: Record<string, unknown>,
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
    connection: EngineRuntimeTypes.RuntimeConnection,
    event: string,
    validationError: unknown,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Promise<void>;
  handleRuntimeError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    error: unknown,
    event?: string,
    routing?: Protocol.WskitRouting,
  ): Promise<void>;
  isChannelPersistent(channelKey: string): boolean;
  persistMembership(identity: string, channelName: string, channelScope: string | null): void;
  deleteDurableMembership(identity: string, channelName: string, channelScope: string | null): void;
}

/**
 * Return the current public member snapshot for a channel.
 *
 * The lookup is always exact-match on the (`channelName`, `channelScope`)
 * pair. Pass `null` for static channels and the family key for dynamic
 * channel families. Two scopes that happen to share a concrete channel name
 * stay strictly isolated — no membership ever crosses into the wrong scope.
 */
export function getChannelMembers(
  runtime: EngineRuntimeTypes.ConnectionMembersRuntime,
  channelName: string,
  channelScope: string | null,
): PublicApi.ConnectionInfo<Record<string, unknown>>[] {
  const members = runtime.channelMembers.get(
    ChannelPrimitive.createChannelMembershipKey(channelName, channelScope),
  );
  if (!members) return [];
  return [...members].map((connection) => runtime.toConnectionInfo(connection));
}

export const leaveChannel = ChannelPrimitive.leaveChannel;

/**
 * Remove tagged members from a channel, typically for moderation or access
 * control.
 */
export function kickChannelMembers(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime.OutgoingRuntime,
      | 'afterSendHooks'
      | 'beforeSendHooks'
      | 'compiled'
      | 'generateId'
      | 'logger'
      | 'pluginRuntimes'
      | 'outgoingHooks'
      | 'waitUntil'
      | 'wskitStampHooks'
    > & {
      leaveChannel(
        connection: EngineRuntimeTypes.RuntimeConnection,
        scope: {
          channel?: EngineCompileTypes.CompiledChannel;
          channelName: string;
          channelScope: string | null;
        },
        kickedReason?: string,
      ): Promise<void>;
    },
  channelName: string,
  target: ChannelPrimitive.KickTarget,
  reason: string,
  channelScope: string | null,
): Promise<void> {
  return ChannelPrimitive.kickChannelMembers(runtime, channelName, target, reason, channelScope);
}

/**
 * Handle the `__subscribe__` protocol frame for a channel.
 */
export async function handleSubscribe(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime.OutgoingRuntime,
      | 'afterSendHooks'
      | 'beforeSendHooks'
      | 'compiled'
      | 'generateId'
      | 'logger'
      | 'pluginRuntimes'
      | 'outgoingHooks'
      | 'waitUntil'
      | 'wskitStampHooks'
    >,
  connection: EngineRuntimeTypes.RuntimeConnection,
  frame: Protocol.SubscribeFrame,
): Promise<void> {
  await ChannelPrimitive.subscribeConnection(
    {
      ...runtime,
      broadcastToChannel: (
        channelName,
        event,
        nextPayload,
        excludeConnectionId,
        channelScope,
        excludeSelf,
      ) => {
        OutgoingRuntime.broadcastToChannel(
          runtime,
          channelName,
          event,
          nextPayload,
          excludeConnectionId,
          channelScope,
          excludeSelf,
        );
      },
      toConnectionInfo: (nextConnection) => runtime.toConnectionInfo(nextConnection),
    },
    connection,
    frame.__wskit.channel,
    frame.__wskit.channelScope,
    frame.payload,
  );
}

/**
 * Server-initiated `channelHandle.subscribe(ref)`. Looks the target connection
 * up from the ref, refuses cross-instance refs until the broker exists, and
 * delegates to the channel primitive's server-side subscribe path.
 */
export async function subscribeFromServer(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime.OutgoingRuntime,
      | 'afterSendHooks'
      | 'beforeSendHooks'
      | 'compiled'
      | 'generateId'
      | 'logger'
      | 'pluginRuntimes'
      | 'outgoingHooks'
      | 'waitUntil'
      | 'wskitStampHooks'
    > & { instanceId: string | undefined },
  ref: { __wskit: 'connection-ref'; id: string; instance: string | undefined; identity: string },
  channelName: string,
  channelScope: string | null,
  payload: unknown,
  rejoining = false,
): Promise<void> {
  if (ref.instance !== runtime.instanceId) {
    throw new Error(
      `[wskit] channelHandle.subscribe(ref) targets instance "${ref.instance ?? 'undefined'}" but this engine is "${runtime.instanceId ?? 'undefined'}" — cross-instance routing requires a broker, which is not configured yet.`,
    );
  }

  const target = runtime.connections.get(ref.id);
  if (!target) {
    throw new Error(
      `[wskit] channelHandle.subscribe(ref) — no live connection with id "${ref.id}" on this instance.`,
    );
  }

  await ChannelPrimitive.subscribeConnectionAsServer(
    {
      ...runtime,
      broadcastToChannel: (
        channelName2,
        event,
        nextPayload,
        excludeConnectionId,
        channelScope2,
        excludeSelf,
      ) => {
        OutgoingRuntime.broadcastToChannel(
          runtime,
          channelName2,
          event,
          nextPayload,
          excludeConnectionId,
          channelScope2,
          excludeSelf,
        );
      },
      toConnectionInfo: (nextConnection) => runtime.toConnectionInfo(nextConnection),
    },
    target,
    channelName,
    channelScope,
    payload,
    rejoining,
  );
}

/**
 * Handle the `__unsubscribe__` protocol frame for a channel.
 */
export async function handleUnsubscribe(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime.OutgoingRuntime,
      | 'afterSendHooks'
      | 'beforeSendHooks'
      | 'compiled'
      | 'generateId'
      | 'logger'
      | 'pluginRuntimes'
      | 'outgoingHooks'
      | 'waitUntil'
      | 'wskitStampHooks'
    > & {
      leaveChannel(
        connection: EngineRuntimeTypes.RuntimeConnection,
        scope: {
          channel?: EngineCompileTypes.CompiledChannel;
          channelName: string;
          channelScope: string | null;
        },
      ): Promise<void>;
    },
  connection: EngineRuntimeTypes.RuntimeConnection,
  frame: Protocol.UnsubscribeFrame,
): Promise<void> {
  await ChannelPrimitive.unsubscribeConnection(
    runtime,
    connection,
    frame.__wskit.channel,
    frame.__wskit.channelScope,
  );
}
