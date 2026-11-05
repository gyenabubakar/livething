import { ChannelNotFound } from '@livething/core';
import * as ChannelRuntime from '~/channel/runtime.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

type BuildChannelHandleOptionsParameter2 = { includeSelf?: boolean };
type BuildChannelsApiOptionsParameter = { isSubscribeGate?: boolean };

type ChannelHandleDeps = Pick<
  EngineContextTypes.BuildConnectionContextDeps,
  | 'broadcastToChannel'
  | 'channelHandleAugmenters'
  | 'getChannelMembers'
  | 'kickChannelMembers'
  | 'sendThroughPipeline'
  | 'broadcastToChannelRecipient'
  | 'subscribeConnectionAsServer'
  | 'addBinarySenders'
>;

interface ChannelHandleScope {
  channelName: string;
  channelFamily: string | null;
  params?: Record<string, string>;
  /** Subscribe gate contexts do not expose channel-only capability surfaces. */
  isSubscribeGate?: boolean;
}

/**
 * Build a `ChannelHandle` bound to the given resolved channel. Used both by
 * `ctx.channel` (in-channel handlers) and `ctx.channels.get(...)` (anywhere).
 *
 * @internal
 */
export function buildChannelHandle(
  connection: EngineRuntimeTypes.RuntimeConnection,
  scope: ChannelHandleScope,
  deps: ChannelHandleDeps,
): PublicApi.ChannelHandle {
  type RuntimeChannelHandle = Omit<PublicApi.ChannelHandle, 'inbox' | 'readReceipts'> &
    Partial<Pick<PublicApi.ChannelHandle, 'inbox' | 'readReceipts'>>;
  const handle: RuntimeChannelHandle = {
    name: scope.channelName,
    family: scope.channelFamily,
    params: scope.params ?? {},
    send: (event: string, payload: unknown) => {
      return deps.sendThroughPipeline(connection, {
        routing: { channel: scope.channelName, channelFamily: scope.channelFamily },
        event,
        payload,
      })
        ? 1
        : 0;
    },
    broadcastTo: (to: PublicApi.ChannelRecipient, event: string, payload: unknown) =>
      deps.broadcastToChannelRecipient({
        channelName: scope.channelName,
        channelFamily: scope.channelFamily,
        to,
        event,
        payload,
      }),
    broadcast: (event: string, payload: unknown, options?: BuildChannelHandleOptionsParameter2) => {
      deps.broadcastToChannel({
        channelName: scope.channelName,
        event,
        payload,
        excludeConnectionId: connection.id,
        excludeResumeToken: connection.resumeToken,
        channelFamily: scope.channelFamily,
        includeSelf: options?.includeSelf,
      });
    },
    members: () => deps.getChannelMembers(scope.channelName, scope.channelFamily),
    subscribe: (ref, payload) =>
      deps.subscribeConnectionAsServer(ref, {
        channelName: scope.channelName,
        channelFamily: scope.channelFamily,
        payload,
      }),
    kick: (target, opts) =>
      deps.kickChannelMembers({
        channelName: scope.channelName,
        target,
        reason: opts.reason,
        channelFamily: scope.channelFamily,
      }),
  };

  deps.addBinarySenders?.(handle, {
    send: 'event-first',
    broadcastTo: 'event-second',
    broadcast: 'event-first',
    request: 'event-first',
  });

  if (!scope.isSubscribeGate) {
    handle.inbox = () => null;
    handle.readReceipts = () => null;

    for (const augment of deps.channelHandleAugmenters ?? []) {
      augment(handle as unknown as Record<PropertyKey, unknown>, {
        channelName: scope.channelName,
        channelFamily: scope.channelFamily,
      });
    }
  }

  return handle as unknown as PublicApi.ChannelHandle;
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
    if ('__livethingChannelRef' in arg) {
      const ref = arg as unknown as { family: string; name: string };
      return { family: ref.family, name: ref.name };
    }

    if ('__livethingChannel' in arg) return (arg as unknown as { __key: string }).__key;
  }

  return arg as string;
}

/** Build the `ctx.channels` helper surface — only `get(...)`. */
export function buildChannelsApi(
  connection: EngineRuntimeTypes.RuntimeConnection,
  deps: ChannelsApiDeps,
  options?: BuildChannelsApiOptionsParameter,
): { get(...args: unknown[]): PublicApi.ChannelHandle } {
  return {
    get(...args: unknown[]) {
      const resolved = deps.resolveChannel(toChannelTarget(args));
      if (!resolved) throw ChannelNotFound();

      return buildChannelHandle(connection, { ...resolved, ...options }, deps);
    },
  };
}

export function buildChannelFamilyExtra(
  connection: EngineRuntimeTypes.RuntimeConnection,
  scope:
    | {
        channel?: EngineCompileTypes.CompiledChannel;
        channelName?: string;
        channelFamily?: string | null;
        isSubscribeGate?: boolean;
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

  return {
    channel: buildChannelHandle(
      connection,
      { channelName, channelFamily, params, isSubscribeGate: scope.isSubscribeGate },
      deps,
    ),
  };
}
