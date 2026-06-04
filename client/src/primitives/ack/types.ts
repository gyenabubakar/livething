/* oxlint-disable @typescript-eslint/no-explicit-any -- ack typing needs `any` to stay generic */
import type { TypeFn } from '~/primitives/types.ts';

/** Adds `socket.sendWithAck(...)` typed from the contract's `outgoing`. */
export interface AckTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends { outgoing: infer O extends Record<string, any> }
    ? {
        sendWithAck<K extends keyof O & string>(
          event: K,
          payload: O[K],
          options?: { timeout?: number; ttl?: number },
        ): Promise<void>;
      }
    : {};
}

/** Options for `ack()`. */
export interface AckOptions {
  /** Default wait for the acknowledgement, in ms. Override per call. Default: `10_000`. */
  timeout?: number;
}
