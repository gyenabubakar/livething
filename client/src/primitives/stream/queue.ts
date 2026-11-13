/**
 * A one-way queue between "chunks arriving from the socket" and a `for await`
 * loop. Chunks are buffered until the loop asks for the next one; if the loop
 * is already waiting, the chunk is delivered immediately.
 * `end()` finishes the loop cleanly, `abort()` makes it throw.
 */
export class StreamQueue<T> {
  private chunks: T[] = [];
  // The byte size of each buffered chunk, at the same index as in `chunks`.
  private sizes: number[] = [];
  private bufferedBytes = 0;
  // Read position into `chunks`. Pulling advances `head` instead of shift()ing,
  // so each pull is O(1) and draining a backlog is O(n), not O(n²). The consumed
  // front is compacted away once it passes half the array.
  private head = 0;
  // Waiters parked by next() when nothing is buffered, oldest first. A FIFO (not a
  // single slot) so two concurrent next() pulls can't overwrite each other's promise
  // and orphan it forever.
  private waiters: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private done = false;
  private error: unknown = null;

  /** `maxBytes` limits the chunks buffered for the loop, as `sizeOf` measures them. */
  constructor(private readonly maxBytes = Number.POSITIVE_INFINITY) {}

  /**
   * A chunk arrived. Returns `false`, and keeps nothing, when buffering it would go over
   * `maxBytes`. `sizeOf` runs only for a chunk that must wait for the loop.
   */
  push(chunk: T, sizeOf?: () => number): boolean {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: chunk, done: false });
      return true;
    }

    const size = sizeOf ? sizeOf() : 0;
    if (this.bufferedBytes + size > this.maxBytes) return false;

    this.bufferedBytes += size;
    this.chunks.push(chunk);
    this.sizes.push(size);

    return true;
  }

  /** Pull the next buffered chunk without re-indexing the array. */
  private take(): T {
    const chunk = this.chunks[this.head]!;
    this.bufferedBytes -= this.sizes[this.head]!;
    this.head++;
    // Once over half the array is consumed, drop the front so a drained queue
    // doesn't hold the whole backing array forever.
    if (this.head > this.chunks.length >> 1) {
      this.chunks = this.chunks.slice(this.head);
      this.sizes = this.sizes.slice(this.head);
      this.head = 0;
    }

    return chunk;
  }

  /** The stream finished — the loop ends after draining what's buffered. */
  end(): void {
    this.done = true;
    while (this.waiters.length) {
      this.waiters.shift()!.resolve({ value: undefined, done: true });
    }
  }

  /** The stream failed — the loop throws. */
  abort(error: unknown): void {
    if (this.done || this.error) return;

    this.error = error;
    while (this.waiters.length) {
      this.waiters.shift()!.reject(error);
    }
  }

  /** Pull the next result, waiting if nothing is ready yet. */
  next(): Promise<IteratorResult<T>> {
    if (this.head < this.chunks.length) {
      return Promise.resolve({ value: this.take(), done: false });
    }

    if (this.error) return Promise.reject(this.error);

    if (this.done) return Promise.resolve({ value: undefined, done: true });

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}
