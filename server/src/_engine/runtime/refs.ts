import { CrossInstanceRef } from '@livething/core';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

type AssertLocalRefRefParameter = { readonly instance: string | undefined };

/** The slice of engine deps the connection handle needs to route a send. */
type ConnectionHandleDeps = Pick<
  EngineContextTypes.ContextCommonDeps,
  'instanceId' | 'logger' | 'sendThroughPipeline'
> & { connections: Map<string, EngineRuntimeTypes.RuntimeConnection> };

/**
 * Build the connection-handle factory backing `ctx.connections.get(ref)`,
 * shared by the connection and connectionless contexts. The returned handle's
 * `send` routes only to the addressed connection. A ref naming another instance
 * is refused via `assertLocalRef`; a ref to a connection no longer live logs and
 * returns `false`.
 */
export function buildConnectionHandle(deps: ConnectionHandleDeps): {
  connection: (ref: PublicApi.ConnectionRef) => PublicApi.ConnectionHandle;
} {
  return {
    connection: (ref) => {
      return {
        send: (event, payload) => {
          assertLocalRef(ref, deps.instanceId, 'ctx.connections.get(ref).send');
          const target = deps.connections.get(ref.id);
          if (!target) {
            deps.logger.error('[livething] ctx.connections.get(ref).send target not found', {
              connectionId: ref.id,
              event,
            });
            return false;
          }

          return deps.sendThroughPipeline(target, { routing: undefined, event, payload });
        },
        close: (code, reason) => {
          assertLocalRef(ref, deps.instanceId, 'ctx.connections.get(ref).close');
          const target = deps.connections.get(ref.id);
          if (!target) {
            deps.logger.error('[livething] ctx.connections.get(ref).close target not found', {
              connectionId: ref.id,
            });
            return;
          }

          target.descriptor.close(code, reason);
        },
      };
    },
  };
}

/**
 * Throw when an addressable `ConnectionRef` or `UserRef` names another engine
 * instance.
 *
 * A ref's `instance` is `undefined` in single-instance setups and always
 * resolves locally. When a broker is configured (future), it carries the target
 * instance id. Until then, any op that targets a different instance has no
 * transport to reach it, so we refuse early with one consistent public error — every
 * ref-addressed op (`ctx.connections.get(ref).send`, `channelHandle.subscribe(ref)`,
 * …) shares this error family.
 *
 * @param ref        The target connection or user ref.
 * @param instanceId This engine's instance id (`undefined` single-instance).
 * @param opLabel    The operation name stored in the error detail, e.g. `ctx.connections.get(ref).send`.
 */
export function assertLocalRef(
  ref: AssertLocalRefRefParameter,
  instanceId: string | undefined,
  opLabel: string,
): void {
  if (ref.instance !== instanceId) {
    throw CrossInstanceRef({
      operation: opLabel,
      ...(ref.instance === undefined ? {} : { targetInstance: ref.instance }),
      ...(instanceId === undefined ? {} : { engineInstance: instanceId }),
    });
  }
}
