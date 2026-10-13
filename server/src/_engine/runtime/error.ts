import { sendProtocolMessage } from '~/_engine/runtime/wire.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as ErrorsPrimitive from '~/errors/runtime.ts';
import { parsePluginWireName } from '~/plugin-scope.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type ResolvedChannel = EngineRuntimeTypes.ResolvedChannel;

/** Builds the ctx passed to `onError`. Supplied by the caller. */
type BuildConnectionContextFn = (
  connection: RuntimeConnection,
  scope?: ResolvedChannel,
) => Record<PropertyKey, unknown>;

interface ErrorHandlerDeps {
  core: EngineCore;
  buildConnectionContext: BuildConnectionContextFn;
}

/**
 * Pull a `ResolvedChannel` out of the `__livething` routing markers on a runtime
 * error so `onError` sees `ctx.channel` matching the throwing handler. Returns
 * `undefined` for unknown or malformed routing — hooks still observe the error
 * at top level.
 */
export function resolveScopeFromRouting(
  core: EngineCore,
  routing: Protocol.LiveThingRouting,
): ResolvedChannel | undefined {
  if (routing.channel !== undefined) {
    if (routing.channelFamily != null) {
      const family = core.compiled.channelFamilies.get(routing.channelFamily);
      if (family && ChannelPrimitive.matchesFamilyPattern(family.pattern, routing.channel)) {
        return {
          channel: family,
          channelName: routing.channel,
          channelFamily: routing.channelFamily,
        };
      }
    } else {
      const channel = core.compiled.channels.get(routing.channel);
      if (channel) {
        return { channel, channelName: routing.channel, channelFamily: null };
      }
    }
  }

  return undefined;
}

/** The plugin a failure belongs to, and the event name as that plugin declared it. */
interface PluginFailureOwner {
  id: string;
  event: string | undefined;
}

/**
 * Find the plugin that owns a failure. A plugin event travels as
 * `__<id>::<name>`, so the event name gives the owner and the short name. A
 * protocol frame (such as `__subscribe__`) on a plugin channel has no plugin
 * event name, so the channel routing gives the owner instead. Returns
 * `undefined` for an app failure.
 */
function pluginFailureOwner(
  event: string | undefined,
  routing: Protocol.LiveThingRouting | undefined,
): PluginFailureOwner | undefined {
  const fromEvent = event === undefined ? null : parsePluginWireName(event);
  if (fromEvent) return { id: fromEvent.id, event: fromEvent.name };

  const channelKey = routing?.channelFamily ?? routing?.channel;
  const fromChannel = typeof channelKey === 'string' ? parsePluginWireName(channelKey) : null;

  return fromChannel ? { id: fromChannel.id, event } : undefined;
}

/** Normalize a thrown error and send the `__error__` protocol frame. */
export async function handleRuntimeError(
  deps: ErrorHandlerDeps,
  connection: RuntimeConnection,
  opts: ErrorsPrimitive.SendRuntimeErrorOptions,
): Promise<void> {
  const { core, buildConnectionContext } = deps;
  // A plugin's `onError` sees only its own failures, under its short event name.
  const owner = pluginFailureOwner(opts.event, opts.routing);
  const pluginHooks = owner
    ? core.hooks.pluginLifecycle.error
        .filter((entry) => entry.pluginId === owner.id)
        .map((entry) => (ctx: unknown, error: unknown) => entry.handler(ctx, error, owner.event))
    : [];

  return ErrorsPrimitive.sendRuntimeError(
    {
      buildConnectionContext,
      asyncContext: core.asyncContext,
      resolveScopeFromRouting: (errorRouting) => resolveScopeFromRouting(core, errorRouting),
      declaredErrorCodes: core.declaredErrorCodes,
      // Inbound onion: the owning plugin's error hooks observe before the app's.
      errorHooks: [...pluginHooks, ...core.hooks.error],
      logger: core.logger,
      sendProtocolMessage: (targetConnection, msgOpts) => {
        sendProtocolMessage(core, targetConnection, msgOpts);
      },
    },
    connection,
    opts,
  );
}

/** Run validation-error hooks before the normal error path takes over. */
export async function handleValidationError(
  deps: ErrorHandlerDeps,
  connection: RuntimeConnection,
  opts: ErrorsPrimitive.NotifyValidationErrorOptions,
): Promise<void> {
  const { core, buildConnectionContext } = deps;
  // A plugin's `onValidationError` sees only its own events, under their short names.
  const owner = parsePluginWireName(opts.event);
  const pluginHooks = owner
    ? core.hooks.pluginLifecycle.validationError
        .filter((entry) => entry.pluginId === owner.id)
        .map(
          (entry) => (ctx: unknown, _event: string, error: unknown) =>
            entry.handler(ctx, owner.name, error),
        )
    : [];

  return ErrorsPrimitive.notifyValidationError(
    {
      buildConnectionContext,
      asyncContext: core.asyncContext,
      validationErrorHooks: [...pluginHooks, ...core.hooks.validationError],
    },
    connection,
    opts,
  );
}
