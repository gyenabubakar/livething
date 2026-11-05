import type { BinaryInput } from '@livething/core';
import type { SendOptions } from '~/messaging.ts';
import type { ChannelTypeFn, Primitive, PrimitiveIdentity, TypeFn } from '~/primitives/types.ts';
import type { IncomingOf, OutgoingOf } from '~/types.ts';

/**
 * The `.binary` key of a socket, a channel handle or a plugin's scoped socket, typed from
 * one scope's `binary` contract. `on` appears only when the scope receives binary events,
 * and `send` only when it sends them.
 */
export type BinaryMessaging<TBinary> = (keyof IncomingOf<TBinary> extends never
  ? {}
  : {
      /**
       * Listen for a binary event. The handler gets the info, then the bytes. The bytes are
       * a view of the received frame, so `bytes.buffer` is the whole frame: copy them with
       * `bytes.slice()` to keep them or to pass an `ArrayBuffer` on. Call the returned
       * function to stop listening.
       */
      on<K extends keyof IncomingOf<TBinary> & string>(
        event: K,
        handler: (info: IncomingOf<TBinary>[K], bytes: Uint8Array) => void,
      ): () => void;
    }) &
  (keyof OutgoingOf<TBinary> extends never
    ? {}
    : {
        /**
         * Send a binary event: the info, then the bytes (none means zero bytes). Returns
         * `true` when the socket sent or buffered it, and `false` when it was dropped,
         * also when the whole frame is over `binary({ maxFrameBytes })`.
         */
        send<K extends keyof OutgoingOf<TBinary> & string>(
          event: K,
          info: OutgoingOf<TBinary>[K],
          bytes?: BinaryInput,
          options?: SendOptions,
        ): boolean;
      });

/**
 * Adds `socket.binary` when the contract has binary entries at the top level. The socket's
 * contract always has a `binary` key, `{}` when there are none.
 */
interface BinaryTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends { binary: infer B }
    ? keyof B extends never
      ? {}
      : { readonly binary: BinaryMessaging<B> }
    : {};
}

/** Adds `.binary` to a channel handle whose channel has binary entries. */
interface BinaryChannelTypeFn extends ChannelTypeFn {
  readonly _api: this['_contract'] extends { binary: infer B }
    ? { readonly binary: BinaryMessaging<B> }
    : {};
}

/** The descriptor `binary()` returns. */
export type BinaryPrimitive = Primitive<BinaryTypeFn, {}, BinaryChannelTypeFn> &
  PrimitiveIdentity<'binary'>;

/** Options for `binary()`. */
export interface BinaryOptions {
  /**
   * The largest frame `binary.send` accepts, in bytes, counting the header, the info and
   * the metadata too. A bigger frame is never sent or queued. Default: `33554432` (32 MiB),
   * the same as the server adapters.
   */
  maxFrameBytes?: number;
}
