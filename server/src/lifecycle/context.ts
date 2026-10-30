import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

/**
 * Build the context passed to the `onInit` lifecycle hook.
 */
export function createInitContext(
  deps: Pick<EngineContextTypes.ContextCommonDeps, 'logger' | 'platform' | 'getStorageView'>,
): PublicApi.InitContext<unknown> {
  const { sql, kv } = deps.getStorageView();
  return {
    sql,
    kv,
    log: deps.logger,
    platform: deps.platform,
  };
}
