/* oxlint-disable @typescript-eslint/no-explicit-any -- request typing needs `any` to stay generic */
import type { TypeFn } from '~/primitives/types.ts';

/**
 * Adds `socket.onRequest(...)` typed from the contract's `serverRequests` —
 * the requests the **server** asks this client, which it answers.
 */
export interface ServerRequestTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends {
    serverRequests: infer R extends Record<string, { payload: any; response: any }>;
  }
    ? {
        /**
         * Register the handler that answers one server→client request. The
         * handler's return value (awaited) is sent back to the server as the
         * answer. Returns an unsubscribe. Registering a second handler for the
         * same event replaces the first.
         */
        onRequest<K extends keyof R & string>(
          event: K,
          handler: (payload: R[K]['payload']) => R[K]['response'] | Promise<R[K]['response']>,
        ): () => void;
      }
    : {};
}

/** Options for `serverRequest()`. */
export interface ServerRequestOptions {}
