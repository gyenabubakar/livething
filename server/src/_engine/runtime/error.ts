import { sendProtocolMessage } from '~/_engine/runtime/wire.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as ErrorsPrimitive from '~/errors/runtime.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type ResolvedScope = EngineRuntimeTypes.ResolvedScope;

/** Builds the ctx passed to `onError`. Supplied by the caller. */
type BuildConnectionContextFn = (
  connection: RuntimeConnection,
  scope?: ResolvedScope,
) => Record<PropertyKey, unknown>;

/**
 * Pull a `ResolvedScope` out of the `__wskit` routing markers on a runtime
 * error so `onError` sees `ctx.namespace` / `ctx.channel` matching the throwing
 * handler. Returns `undefined` for unknown or malformed routing — hooks still
 * observe the error at top level.
 */
export function resolveScopeFromRouting(
  core: EngineCore,
  routing: Protocol.WskitRouting,
): ResolvedScope | undefined {
  if (routing.namespace !== undefined) {
    const namespace = core.compiled.namespaces.get(routing.namespace);
    if (namespace) return { namespace };
  }
  if (routing.channel !== undefined) {
    if (routing.channelScope != null) {
      const family = core.compiled.channelFamilies.get(routing.channelScope);
      if (family && ChannelPrimitive.matchesScopePattern(family.pattern, routing.channel)) {
        return {
          channel: family,
          channelName: routing.channel,
          channelScope: routing.channelScope,
        };
      }
    } else {
      const channel = core.compiled.channels.get(routing.channel);
      if (channel) {
        return { channel, channelName: routing.channel, channelScope: null };
      }
    }
  }
  return undefined;
}

/** Normalize a thrown error and send the `__error__` protocol frame. */
export async function handleRuntimeError(
  core: EngineCore,
  buildConnectionContext: BuildConnectionContextFn,
  connection: RuntimeConnection,
  error: unknown,
  event?: string,
  routing?: Protocol.WskitRouting,
): Promise<void> {
  return ErrorsPrimitive.sendRuntimeError(
    {
      buildConnectionContext,
      resolveScopeFromRouting: (errorRouting) => resolveScopeFromRouting(core, errorRouting),
      declaredErrorCodes: core.declaredErrorCodes,
      errorHooks: core.hooks.error,
      logger: core.logger,
      sendProtocolMessage: (targetConnection, outgoingEvent, payload, wskit) => {
        sendProtocolMessage(core, targetConnection, outgoingEvent, payload, wskit);
      },
    },
    connection,
    error,
    event,
    routing,
  );
}

/** Run validation-error hooks before the normal error path takes over. */
export async function handleValidationError(
  core: EngineCore,
  buildConnectionContext: BuildConnectionContextFn,
  connection: RuntimeConnection,
  event: string,
  validationError: unknown,
  scope?: ResolvedScope,
): Promise<void> {
  return ErrorsPrimitive.notifyValidationError(
    {
      buildConnectionContext,
      validationErrorHooks: core.hooks.validationError,
    },
    connection,
    event,
    validationError,
    scope,
  );
}
