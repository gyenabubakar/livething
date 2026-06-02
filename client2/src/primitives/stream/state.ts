import { StreamQueue } from '~/primitives/stream/queue.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';

/** Everything tracked for one running client-initiated stream. */
export class StreamState {
  /** Chunks flow through here to the developer's `for await` loop. */
  readonly queue = new StreamQueue<unknown>();
  /** Still running? Goes false on end, error, cancel, or a terminal disconnect. */
  active = true;
  /** Highest `seq` delivered, so a resume that rewinds doesn't yield a chunk twice. */
  lastSeq = Number.NEGATIVE_INFINITY;
  /** The per-chunk timeout, reset on every chunk. */
  timer: ReturnType<typeof setTimeout> | null = null;
  /** Set from `__streamOk__`'s `streamKind`: persistent streams resume on reconnect. */
  resumable = false;

  constructor(
    readonly streamId: string,
    readonly event: string,
    readonly markers: ScopeMarkers,
  ) {}
}
