import { StreamQueue } from '~/primitives/stream/queue.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';

/** Everything tracked for one running client-initiated stream. */
export class StreamState {
  /** Chunks flow through here to the developer's `for await` loop. */
  readonly queue = new StreamQueue<unknown>();
  /** Still running? Goes false on end, error, cancel, or a terminal disconnect. */
  active = true;
  /** Highest `seq` delivered so far, so chunks already seen are skipped after a resume. */
  lastSeq = Number.NEGATIVE_INFINITY;
  /** The per-chunk timeout, reset on every chunk. */
  timer: ReturnType<typeof setTimeout> | null = null;
  /** A bounded deadline armed while a reconnect resume is in flight, cleared on the
   * first resumed chunk — so a server that never resumes can't hang the iterator. */
  resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set from `__streamOk__`'s `streamKind`: persistent streams resume on reconnect. */
  resumable = false;

  constructor(
    readonly streamId: string,
    readonly event: string,
    readonly markers: ScopeMarkers,
  ) {}
}
