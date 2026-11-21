import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

/**
 * Build what every server context shares: the `onInit` and `authenticate` context, and the
 * part of every other context that is not about a connection or the whole server.
 */
export function createHostContext(
  deps: Pick<
    EngineContextTypes.ContextCommonDeps,
    'logger' | 'platform' | 'getStorageView' | 'messageLimits'
  >,
): PublicApi.HostContext<unknown> {
  const { sql, kv } = deps.getStorageView();
  return {
    sql,
    kv,
    log: deps.logger,
    platform: deps.platform,
    messageLimits: deps.messageLimits,
  };
}
