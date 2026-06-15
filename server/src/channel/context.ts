import { ChannelNotFound } from '@wskit/core';
import * as ChannelRuntime from '~/channel/runtime.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

type ChannelHandleDeps = Pick<
  EngineContextTypes.BuildConnectionContextDeps,
  | 'broadcastToChannel'
  | 'getChannelMembers'
  | 'kickChannelMembers'
  | 'removeChannelMember'
  | 'sendThroughPipeline'
  | 'subscribeConnectionAsServer'
>;

/**
 * Build a `ChannelHandle` bound to the given resolved scope. Used both by
 * `ctx.channel` (in-channel handlers) and `ctx.channels.get(...)` (anywhere).
 *
 * @internal
 */
export function buildChannelHandle(
  connection: EngineContextTypes.RuntimeConnection,
  scope: { channelName: string; channelScope: string | null; params?: Record<string, string> },
  deps: ChannelHandleDeps,
): PublicApi.ChannelHandle {
  return {
    name: scope.channelName,
    scope: scope.channelScope,
    params: scope.params ?? {},
    send: (event: string, payload: unknown) =>
      deps.sendThroughPipeline(connection, {
        routing: { channel: scope.channelName, channelScope: scope.channelScope },
        event,
        payload,
      }),
    broadcast: (event: string, payload: unknown, options?: { excludeSelf?: boolean }) => {
      deps.broadcastToChannel({
        channelName: scope.channelName,
        event,
        payload,
        excludeConnectionId: connection.id,
        channelScope: scope.channelScope,
        excludeSelf: options?.excludeSelf,
      });
    },
    members: () => deps.getChannelMembers(scope.channelName, scope.channelScope),
    subscribe: (ref, payload) =>
      deps.subscribeConnectionAsServer(ref, {
        channelName: scope.channelName,
        channelScope: scope.channelScope,
        payload,
      }),
    kick: (target, reason: string) =>
      deps.kickChannelMembers({
        channelName: scope.channelName,
        target,
        reason,
        channelScope: scope.channelScope,
      }),
    removeMember: (identity: string) =>
      deps.removeChannelMember(scope.channelName, scope.channelScope, identity),
  };
}

type ChannelsApiDeps = ChannelHandleDeps &
  Pick<EngineContextTypes.BuildConnectionContextDeps, 'resolveChannel'>;

/** Build the `ctx.channels` helper surface — only `get(...)`. */
export function buildChannelsApi(
  connection: EngineContextTypes.RuntimeConnection,
  deps: ChannelsApiDeps,
): { get(...args: unknown[]): PublicApi.ChannelHandle } {
  return {
    get(...args: unknown[]) {
      const target =
        args.length >= 2
          ? { family: args[0] as string, name: args[1] as string }
          : (args[0] as string);
      const resolved = deps.resolveChannel(target);
      if (!resolved) throw ChannelNotFound();
      return buildChannelHandle(connection, resolved, deps);
    },
  };
}

export function buildChannelScopeExtra(
  connection: EngineContextTypes.RuntimeConnection,
  scope:
    | {
        channel?: EngineContextTypes.CompiledChannel;
        channelName?: string;
        channelScope?: string | null;
      }
    | undefined,
  deps: ChannelHandleDeps,
): { channel?: PublicApi.ChannelHandle } {
  if (!scope?.channel) return {};
  const channel = scope.channel;
  const channelName =
    scope.channelName ?? (typeof channel.pattern === 'string' ? channel.pattern : '');
  const channelScope = scope.channelScope ?? null;
  const params = ChannelRuntime.matchScopeParams(channel.pattern, channelName);
  return { channel: buildChannelHandle(connection, { channelName, channelScope, params }, deps) };
}
