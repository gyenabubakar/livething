import { sendProtocolMessage } from '~/_engine/runtime/wire.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as ErrorsPrimitive from '~/errors/runtime.ts';
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
 * Pull a `ResolvedChannel` out of the `__wskit` routing markers on a runtime
 * error so `onError` sees `ctx.channel` matching the throwing handler. Returns
 * `undefined` for unknown or malformed routing — hooks still observe the error
 * at top level.
 */
export function resolveScopeFromRouting(
  core: EngineCore,
  routing: Protocol.WSKitRouting,
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

/** Normalize a thrown error and send the `__error__` protocol frame. */
export async function handleRuntimeError(
  deps: ErrorHandlerDeps,
  connection: RuntimeConnection,
  opts: ErrorsPrimitive.SendRuntimeErrorOptions,
): Promise<void> {
  const { core, buildConnectionContext } = deps;
  return ErrorsPrimitive.sendRuntimeError(
    {
      buildConnectionContext,
      resolveScopeFromRouting: (errorRouting) => resolveScopeFromRouting(core, errorRouting),
      declaredErrorCodes: core.declaredErrorCodes,
      // Inbound onion: new-model plugin error hooks observe before the app's.
      errorHooks: [
        ...core.hooks.pluginLifecycle.error.map((entry) => entry.handler),
        ...core.hooks.error,
      ],
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
  return ErrorsPrimitive.notifyValidationError(
    {
      buildConnectionContext,
      validationErrorHooks: [
        ...core.hooks.pluginLifecycle.validationError.map((entry) => entry.handler),
        ...core.hooks.validationError,
      ],
    },
    connection,
    opts,
  );
}
