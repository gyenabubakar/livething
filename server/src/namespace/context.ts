import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

type NamespaceScopeDeps = Pick<
  EngineContextTypes.BuildConnectionContextDeps,
  'broadcastToConnections' | 'connections' | 'sendThroughPipeline'
>;

// When a handler runs inside a namespace, ctx.namespace gives it scope-bound
// send + broadcast helpers. Returns {} when scope has no active namespace.
export function buildNamespaceScopeExtra(
  connection: EngineContextTypes.RuntimeConnection,
  scope: { namespace?: EngineContextTypes.CompiledNamespace } | undefined,
  deps: NamespaceScopeDeps,
): { namespace?: PublicApi.ScopeSendApi } {
  if (!scope?.namespace) return {};
  const namespace = scope.namespace;
  return {
    namespace: {
      name: namespace.name,
      send: (event: string, payload: unknown) => {
        return deps.sendThroughPipeline(connection, {
          routing: { namespace: namespace.name },
          event,
          payload,
        });
      },
      broadcast: (event: string, payload: unknown, options?: { excludeSelf?: boolean }) => {
        deps.broadcastToConnections([...deps.connections.values()], {
          event,
          payload,
          options: { namespace: namespace.name, excludeSelf: options?.excludeSelf },
          excludeConnectionId: connection.id,
        });
      },
    },
  };
}
