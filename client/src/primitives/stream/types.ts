/* oxlint-disable @typescript-eslint/no-explicit-any -- contract matching needs `any` to stay generic */
import type { Primitive, PrimitiveIdentity, TypeFn } from '~/primitives/types.ts';
import type { NudgesOf, PersistentStreamKeys, StreamHandle, StreamHandlers } from '~/types.ts';

/** Options for the `stream()` primitive. */
export interface StreamOptions {
  /**
   * How long to wait for the next chunk before giving up, in ms. Resets on every
   * chunk — it's a per-chunk limit, not a total duration. Default: `30_000`.
   */
  timeout?: number;
  /** How long `nudge()` waits for `__nudgeOk__`, in ms. Default: `10_000`. */
  nudgeTimeout?: number;
}

/** Per-call options when triggering a stream. */
export interface StreamTriggerOptions {
  /** Pin the stream id (e.g. to a conversation id) instead of letting one be generated. */
  streamId?: string;
}

/**
 * Adds `socket.stream(...)`, `socket.onStream(...)` and `socket.continueStream(...)`,
 * typed from the contract's `streams`.
 */
export interface StreamTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends {
    streams: infer S extends Record<string, { payload: any; chunk: any }>;
  }
    ? {
        stream<K extends keyof S & string>(
          event: K,
          payload: S[K]['payload'],
          options?: StreamTriggerOptions,
        ): Promise<StreamHandle<S[K]['chunk'], NudgesOf<S[K]>>>;
        onStream<K extends keyof S & string>(
          event: K,
          handlers: StreamHandlers<S[K]['chunk']>,
        ): () => void;
        continueStream<K extends PersistentStreamKeys<S> & string>(
          event: K,
          streamId: string,
          options?: { lastKnownSeq?: number },
        ): StreamHandle<S[K]['chunk'], NudgesOf<S[K]>>;
      }
    : {};
}

/** The descriptor `stream()` returns. */
export type StreamPrimitive = Primitive<StreamTypeFn> & PrimitiveIdentity<'stream'>;
