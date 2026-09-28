import { StreamQueue } from '~/primitives/stream/queue.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';

/** Everything tracked for one running client-initiated stream. */
export class StreamState {
  /** Chunks flow through here to the developer's `for await` loop. */
  readonly queue = new StreamQueue<unknown>();
  /** Still running? Goes false on end, error, cancel, or a terminal disconnect. */
  active = true;
  /** Highest `seq` delivered so far, so chunks already seen are skipped after a reconnect. */
  lastSeq = Number.NEGATIVE_INFINITY;
  /** The per-chunk timeout, reset on every chunk. */
  timer: ReturnType<typeof setTimeout> | null = null;
  /** A bounded deadline armed while a continue request is in flight, cleared on the
   * first continued chunk — so a server that never continues can't hang the iterator. */
  continueTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set from `__streamOk__`'s stream durability: persistent streams continue on reconnect. */
  durable = false;
  /**
   * Whether this stream currently holds a lazy-consumer hold. Used to make
   * acquire/release idempotent across a reconnect window: a durable stream
   * releases its hold on an unexpected drop and re-acquires on reconnect, and if
   * several reconnect attempts each fire onClose, only the first release counts —
   * otherwise the global lazy count is corrupted for unrelated consumers.
   */
  hasLazyHold = false;

  constructor(
    readonly streamId: string,
    readonly event: string,
    readonly markers: ScopeMarkers,
  ) {}
}
