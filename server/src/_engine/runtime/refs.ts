import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

/** The slice of engine deps the connection handle needs to route a send. */
type ConnectionHandleDeps = Pick<
  EngineContextTypes.ContextCommonDeps,
  'instanceId' | 'logger' | 'sendThroughPipeline'
> & { connections: Map<string, EngineRuntimeTypes.RuntimeConnection> };

/**
 * Build the `ctx.connection(ref)` factory shared by the connection and task
 * contexts. The returned handle's `send` routes only to the addressed
 * connection. A ref naming another instance is refused via `assertLocalRef`; a
 * ref to a connection no longer live logs and returns `false`.
 */
export function buildConnectionHandle(deps: ConnectionHandleDeps): {
  connection: (ref: PublicApi.ConnectionRef) => PublicApi.ConnectionHandle;
} {
  return {
    connection: (ref) => {
      assertLocalRef(ref, deps.instanceId, 'ctx.connection(ref).send');
      return {
        send: (event, payload) => {
          const target = deps.connections.get(ref.id);
          if (!target) {
            deps.logger.error('[wskit] ctx.connection(ref).send target not found', {
              connectionId: ref.id,
              event,
            });
            return false;
          }
          return deps.sendThroughPipeline(target, { routing: undefined, event, payload });
        },
      };
    },
  };
}

/**
 * Throw when a `ConnectionRef` names another engine instance.
 *
 * A ref's `instance` is `undefined` in single-instance setups and always
 * resolves locally. When a broker is configured (future), it carries the target
 * instance id. Until then, any op that targets a different instance has no
 * transport to reach it, so we refuse early with one consistent message — every
 * ref-addressed op (`ctx.connection(ref).send`, `channelHandle.subscribe(ref)`,
 * …) shares this error family.
 *
 * @param ref        The target connection ref.
 * @param instanceId This engine's instance id (`undefined` single-instance).
 * @param opLabel    The op name shown in the message, e.g. `ctx.connection(ref).send`.
 */
export function assertLocalRef(
  ref: { readonly instance: string | undefined },
  instanceId: string | undefined,
  opLabel: string,
): void {
  if (ref.instance !== instanceId) {
    throw new Error(
      `[wskit] ${opLabel} targets instance "${ref.instance ?? 'undefined'}" but this engine is ` +
        `"${instanceId ?? 'undefined'}" — cross-instance routing requires a broker, which is not ` +
        'configured yet.',
    );
  }
}
