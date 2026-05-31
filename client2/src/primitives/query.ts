import type { EmptyTypeFn, PrimitiveSpec } from '~/primitives/types.ts';

/** A function returning query params, called on every connect and reconnect. */
export type QueryFn = () => Record<string, string> | Promise<Record<string, string>>;

/**
 * Inject query params onto the WebSocket URL on every connect and reconnect.
 * Can be async (e.g. to refresh an auth token between attempts).
 *
 * ```ts
 * query(async () => ({ token: await getAuthToken(), client: 'web' }));
 * ```
 */
export function query(fn: QueryFn): PrimitiveSpec<EmptyTypeFn> {
  return {
    _tag: 'query',
    applyConfig(config) {
      config.searchParams = fn;
    },
  };
}
