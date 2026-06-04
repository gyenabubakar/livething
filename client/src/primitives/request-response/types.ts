/* oxlint-disable @typescript-eslint/no-explicit-any -- request typing needs `any` to stay generic */
import type { TypeFn } from '~/primitives/types.ts';

/** Adds `socket.request(...)` typed from the contract's `requests`. */
export interface RequestResponseTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends {
    requests: infer R extends Record<string, { payload: any; response: any }>;
  }
    ? {
        request<K extends keyof R & string>(
          event: K,
          payload: R[K]['payload'],
          options?: { timeout?: number },
        ): Promise<R[K]['response']>;
      }
    : {};
}

/** Options for `requestResponse()`. */
export interface RequestResponseOptions {
  /** Default wait for a reply, in ms. Override per call. Default: `10_000`. */
  timeout?: number;
}
