import { ChannelNotFound } from '@wskit/core';
import * as ChannelRuntime from '~/channel/runtime.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

type ChannelHandleDeps = Pick<
  EngineContextTypes.BuildConnectionContextDeps,
  | 'broadcastToChannel'
  | 'channelHandleAugmenters'
  | 'getChannelMembers'
  | 'kickChannelMembers'
  | 'removeChannelMember'
  | 'sendThroughPipeline'
  | 'subscribeConnectionAsServer'
>;

/**
 * Build a `ChannelHandle` bound to the given resolved channel. Used both by
 * `ctx.channel` (in-channel handlers) and `ctx.channels.get(...)` (anywhere).
 *
 * @internal
 */
export function buildChannelHandle(
  connection: EngineContextTypes.RuntimeConnection,
  scope: { channelName: string; channelFamily: string | null; params?: Record<string, string> },
  deps: ChannelHandleDeps,
): PublicApi.ChannelHandle {
  const handle: PublicApi.ChannelHandle = {
    name: scope.channelName,
    family: scope.channelFamily,
    params: scope.params ?? {},
    send: (event: string, payload: unknown) =>
      deps.sendThroughPipeline(connection, {
        routing: { channel: scope.channelName, channelFamily: scope.channelFamily },
        event,
        payload,
      }),
    broadcast: (event: string, payload: unknown, options?: { excludeSelf?: boolean }) => {
      deps.broadcastToChannel({
        channelName: scope.channelName,
        event,
        payload,
        excludeConnectionId: connection.id,
        channelFamily: scope.channelFamily,
        excludeSelf: options?.excludeSelf,
      });
    },
    members: () => deps.getChannelMembers(scope.channelName, scope.channelFamily),
    subscribe: (ref, payload) =>
      deps.subscribeConnectionAsServer(ref, {
        channelName: scope.channelName,
        channelFamily: scope.channelFamily,
        payload,
      }),
    kick: (target, reason: string) =>
      deps.kickChannelMembers({
        channelName: scope.channelName,
        target,
        reason,
        channelFamily: scope.channelFamily,
      }),
    removeMember: (identity: string) =>
      deps.removeChannelMember(scope.channelName, scope.channelFamily, identity),
    inbox: () => null,
    readReceipts: () => null,
  };

  for (const augment of deps.channelHandleAugmenters ?? []) {
    augment(handle as unknown as Record<PropertyKey, unknown>, {
      channelName: scope.channelName,
      channelFamily: scope.channelFamily,
    });
  }

  return handle;
}

type ChannelsApiDeps = ChannelHandleDeps &
  Pick<EngineContextTypes.BuildConnectionContextDeps, 'resolveChannel'>;

/**
 * Normalize the arguments of `ctx.channels.get(...)` to a resolve target. Accepts
 * a static channel declaration, a family declaration's `.at(params)` ref, a raw channel name,
 * or a `(family, name)` pair.
 */
function toChannelTarget(args: unknown[]): string | { family: string; name: string } {
  if (args.length >= 2) return { family: args[0] as string, name: args[1] as string };
  const arg = args[0];
  if (arg && typeof arg === 'object') {
    if ('__wskitChannelRef' in arg) {
      const ref = arg as unknown as { family: string; name: string };
      return { family: ref.family, name: ref.name };
    }
    if ('__wskitChannel' in arg) return (arg as unknown as { __key: string }).__key;
  }
  return arg as string;
}

/** Build the `ctx.channels` helper surface — only `get(...)`. */
export function buildChannelsApi(
  connection: EngineContextTypes.RuntimeConnection,
  deps: ChannelsApiDeps,
): { get(...args: unknown[]): PublicApi.ChannelHandle } {
  return {
    get(...args: unknown[]) {
      const resolved = deps.resolveChannel(toChannelTarget(args));
      if (!resolved) throw ChannelNotFound();
      return buildChannelHandle(connection, resolved, deps);
    },
  };
}

export function buildChannelFamilyExtra(
  connection: EngineContextTypes.RuntimeConnection,
  scope:
    | {
        channel?: EngineContextTypes.CompiledChannel;
        channelName?: string;
        channelFamily?: string | null;
      }
    | undefined,
  deps: ChannelHandleDeps,
): { channel?: PublicApi.ChannelHandle } {
  if (!scope?.channel) return {};
  const channel = scope.channel;
  const channelName =
    scope.channelName ?? (typeof channel.pattern === 'string' ? channel.pattern : '');
  const channelFamily = scope.channelFamily ?? null;
  const params = ChannelRuntime.matchScopeParams(channel.pattern, channelName);
  return { channel: buildChannelHandle(connection, { channelName, channelFamily, params }, deps) };
}
