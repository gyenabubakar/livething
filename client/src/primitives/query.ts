import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** A function that returns query params; it runs on every connect and reconnect. */
export type QueryFn = () => Record<string, string> | Promise<Record<string, string>>;

/**
 * Adds query params to the connection URL each time it connects — the usual way
 * to pass an auth token, since browsers can't set WebSocket headers. Because it
 * runs again on every reconnect, a refreshed token is picked up automatically.
 *
 * ```ts
 * query(async () => ({ token: await getAuthToken(), client: 'web' }));
 * ```
 */
export function query(getParams: QueryFn): Primitive<EmptyTypeFn> {
  return {
    _tag: 'query',
    setup() {
      function append(baseUrl: string, params: Record<string, string>): string {
        const search = new URLSearchParams(params).toString();
        if (!search) return baseUrl;
        const separator = baseUrl.includes('?') ? '&' : '?';
        return `${baseUrl}${separator}${search}`;
      }

      return {
        id: 'query',
        resolveUrl(baseUrl) {
          const params = getParams();
          return params instanceof Promise
            ? params.then((resolved) => append(baseUrl, resolved))
            : append(baseUrl, params);
        },
      };
    },
  };
}
