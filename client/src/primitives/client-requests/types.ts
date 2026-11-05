/* oxlint-disable @typescript-eslint/no-explicit-any -- request typing needs `any` to stay generic */
import type { Primitive, PrimitiveIdentity, TypeFn } from '~/primitives/types.ts';

/** Adds `socket.request(...)` typed from the contract's `clientRequests`. */
interface ClientRequestsTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends {
    clientRequests: infer R extends Record<string, { payload: any; response: any }>;
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

/** The descriptor `clientRequests()` returns. */
export type ClientRequestsPrimitive = Primitive<ClientRequestsTypeFn> &
  PrimitiveIdentity<'clientRequests'>;

/** Options for `clientRequests()`. */
export interface ClientRequestsOptions {
  /** Default wait for a reply, in ms, from 1 to `2 ** 31 - 1`. Override per call. Default: `10_000`. */
  timeout?: number;
}
