import * as EngineCompileUtils from '~/_engine/compile/utils.ts';
import * as DefinePlugin from '~/plugins/define.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PrimitiveCore from '~/primitive.ts';

/**
 * Wrap a context so plugin event helpers automatically prefix their event names.
 *
 * Plugins declare outgoing events with short names (e.g. `'flushed'`), but on
 * the wire they become `'__acme:analytics:flushed'`. This Proxy intercepts
 * `send`, `broadcast`, `sendTo`, and `connection(ref).send` and prepends the
 * plugin's ID before delegating to the real context method.
 */
export function createPluginScopedContext(
  pluginId: string,
  ctx: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> {
  function prefix(event: string): string {
    return EngineCompileUtils.prefixedPluginEvent(pluginId, event);
  }

  return new Proxy(ctx, {
    get(target, key, receiver) {
      switch (key) {
        case 'send':
          return wrapPrefixedSend({
            target,
            receiver,
            key: 'send',
            prefix,
            position: 'event-first',
          });
        case 'broadcast':
          return wrapPrefixedSend({
            target,
            receiver,
            key: 'broadcast',
            prefix,
            position: 'event-first',
          });
        case 'connection': {
          const original = Reflect.get(target, key, receiver) as (ref: unknown) => {
            send: (event: string, payload: unknown) => boolean;
          };
          if (typeof original !== 'function') return original;
          return (ref: unknown) => {
            const handle = original(ref);
            return {
              ...handle,
              send: (event: string, payload: unknown) => handle.send(prefix(event), payload),
            };
          };
        }
        default:
          return Reflect.get(target, key, receiver);
      }
    },
  });
}

interface WrapPrefixedSendOptions {
  target: Record<PropertyKey, unknown>;
  receiver: unknown;
  key: 'send' | 'broadcast';
  prefix: (event: string) => string;
  position: 'event-first';
}

/**
 * Build a wrapper around a `(event, payload, ...rest)` send-like method on a
 * connection context. The wrapper rewrites the `event` argument through
 * `prefix` and forwards every other argument unchanged.
 */
function wrapPrefixedSend({
  target,
  receiver,
  key,
  prefix,
}: WrapPrefixedSendOptions): (...args: unknown[]) => unknown {
  const original = Reflect.get(target, key, receiver) as (...args: unknown[]) => unknown;
  return (event: unknown, ...rest: unknown[]) => original(prefix(event as string), ...rest);
}

/**
 * Attach plugin API objects to the hidden plugin API map on a context.
 */
export function attachPluginApis(
  pluginRuntimes: readonly EngineContextTypes.PluginRuntime[],
  ctx: Record<PropertyKey, unknown>,
  connection?: EngineContextTypes.RuntimeConnection,
): void {
  const apiMap: Record<PropertyKey, unknown> = {};

  for (const runtime of pluginRuntimes) {
    const pluginCtx = createPluginScopedContext(runtime.instance.id, ctx);
    const api = runtime.contextFactory(pluginCtx);
    apiMap[(runtime.instance as PrimitiveCore.Primitive).__identity[0]] = api;

    if (connection) {
      apiMap[runtime.instance.id] = api;
    }
  }

  Object.defineProperty(ctx, DefinePlugin.PLUGIN_API_MAP, {
    configurable: true,
    enumerable: false,
    value: apiMap,
    writable: false,
  });
}
