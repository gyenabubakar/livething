import type { ReadableStore } from '~/internal/store.ts';
import type { ChannelTypeFn, Primitive, PrimitiveIdentity, TypeFn } from '~/primitives/types.ts';

/** One connection's state in a channel. */
export interface AwarenessEntry<S> {
  connectionId: string;
  /** The user ID on a durable channel with a signed-in user, else the connection ID. */
  memberId: string;
  /** The member's `meta` when the entry appeared. */
  meta: Record<string, unknown>;
  state: S;
  /** Client clock: when the server took this state. */
  updatedAt: number;
}

/** Why the server, or this client, refused an update. */
export interface AwarenessRefusal {
  /** `error`: the app's `check` threw, or the server could not send the entry (a `meta` too large). */
  reason: 'too-large' | 'invalid' | 'check' | 'error';
}

/** `channel.awareness`: live state for each connection in the channel. */
export interface ChannelAwarenessApi<S> {
  /**
   * Replace this connection's state. Throttled; not merged with the old state. Ignored if
   * the channel is not joined. A state over the channel's `maxBytes`, or one that is not a
   * plain JSON object, is not kept or sent: `onRefused` gets `too-large` or `invalid`.
   */
  set(state: S): void;
  /** Clear this connection's state now. Not throttled; drops a waiting set. */
  clear(): void;
  /** What this client last asked for. Sent again after each rejoin. */
  readonly mine: ReadableStore<S | null>;
  /** What the server holds for this connection, from the server's own changes. */
  readonly self: ReadableStore<AwarenessEntry<S> | null>;
  /** Every other connection in the channel that has a state, by connection ID. */
  readonly others: ReadableStore<ReadonlyMap<string, AwarenessEntry<S>>>;
  /** `false` until the first full sync after each (re)subscribe. */
  readonly synced: ReadableStore<boolean>;
  /** An update from this client was refused. Returns an unsubscribe. */
  onRefused(callback: (refusal: AwarenessRefusal) => void): () => void;
}

/** Options for the client `awareness()` primitive. */
export interface AwarenessOptions {
  /** Least time between two updates sent for one channel, in ms. `0` turns it off. Default 50. */
  throttleMs?: number;
}

interface AwarenessTypeFn extends TypeFn {
  readonly _api: {};
}

/** Adds `awareness` to the handles of channels whose contract has it. */
interface AwarenessChannelTypeFn extends ChannelTypeFn {
  readonly _api: this['_contract'] extends { awareness: infer S }
    ? { readonly awareness: ChannelAwarenessApi<S> }
    : {};
}

/** The descriptor `awareness()` returns. */
export type AwarenessPrimitive = Primitive<AwarenessTypeFn, {}, AwarenessChannelTypeFn> &
  PrimitiveIdentity<'awareness', 'channels'>;
