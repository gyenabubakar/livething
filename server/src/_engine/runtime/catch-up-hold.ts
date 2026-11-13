import type { TransportFrame } from '~/_adapters/types.ts';
import type { RuntimeConnection } from './types.ts';

/**
 * The frames a connection holds back while replay catches it up. Only a frame with a
 * `delivery.seq` of a store being caught up waits here: the client keeps the highest seq it
 * saw for each store, so that frame going out first would move its cursor past rows it has
 * not got yet. Every other frame goes out at once.
 */
export interface CatchUpHold {
  /** The frames each store holds, by the store's key (see `seqScopeKey`), in send order. */
  readonly scopes: Map<string, HeldScope>;
  /** The bytes of every held frame. The slow-client check counts them as the backlog. */
  bytes: number;
}

interface HeldScope {
  frames: TransportFrame[];
  bytes: number;
  /** How many catch-ups of this store are running. */
  catchUps: number;
}

/** The store each frame with a delivery seq belongs to. Set once, when the frame is built. */
const seqScopes = new WeakMap<TransportFrame, string>();

/**
 * The key of the replay store a frame belongs to: `''` for the top level, or the channel's.
 * The same rule as `replayScopeKey`, so a frame and a catch-up name a store the same way.
 */
export function seqScopeKey(channel: string | null, channelFamily: string | null): string {
  return channel === null ? '' : JSON.stringify([channelFamily, channel]);
}

/**
 * Mark a frame built from this `__livething` block when it carries a delivery seq. A request,
 * a reply and a stream chunk have their own order, so they are never marked.
 */
export function markSeqScope(frame: TransportFrame, livething: Record<string, unknown>): void {
  if (typeof livething.deliverySeq !== 'number') return;

  if (livething.correlationId !== undefined || livething.streamId !== undefined) return;

  const channel = typeof livething.channel === 'string' ? livething.channel : null;
  const family = typeof livething.channelFamily === 'string' ? livething.channelFamily : null;
  seqScopes.set(frame, seqScopeKey(channel, family));
}

/** The held frames of the store this frame belongs to, when that store is being caught up. */
export function heldScopeOf(
  hold: CatchUpHold | undefined,
  frame: TransportFrame,
): HeldScope | undefined {
  const key = hold && seqScopes.get(frame);
  return key === undefined ? undefined : hold!.scopes.get(key);
}

/** Start holding the frames of one store, for one catch-up. */
export function beginCatchUpHold(connection: RuntimeConnection, key: string): void {
  connection.catchUpHold ??= { scopes: new Map(), bytes: 0 };
  const scopes = connection.catchUpHold.scopes;
  const held = scopes.get(key) ?? { frames: [], bytes: 0, catchUps: 0 };
  held.catchUps += 1;
  scopes.set(key, held);
}

/**
 * End one catch-up of a store. When it was the last, its held frames go out, in send order,
 * through the normal send checks.
 */
export function endCatchUpHold(connection: RuntimeConnection, key: string): void {
  const hold = connection.catchUpHold;
  const held = hold?.scopes.get(key);
  if (!hold || !held) return;

  held.catchUps -= 1;
  if (held.catchUps > 0) return;

  hold.scopes.delete(key);
  hold.bytes -= held.bytes;
  if (hold.scopes.size === 0) connection.catchUpHold = undefined;

  if (connection.closing) return;

  for (const frame of held.frames) {
    if (connection.descriptor.send(frame) === false) return;
  }
}
