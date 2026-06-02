/**
 * A one-way queue that bridges "chunks arrive from the socket" with "a `for
 * await` loop pulls them." Chunks are buffered until the loop asks for the next
 * one; if the loop is already waiting, the chunk is handed over straight away.
 * `end()` finishes the loop, `abort()` makes it throw.
 */
export class StreamQueue<T> {
  private chunks: T[] = [];
  private resolveNext: ((result: IteratorResult<T>) => void) | null = null;
  private rejectNext: ((error: unknown) => void) | null = null;
  private done = false;
  private error: unknown = null;

  /** A chunk arrived. */
  push(chunk: T): void {
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = this.rejectNext = null;
      resolve({ value: chunk, done: false });
    } else {
      this.chunks.push(chunk);
    }
  }

  /** The stream finished — the loop ends after draining what's buffered. */
  end(): void {
    this.done = true;
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = this.rejectNext = null;
      resolve({ value: undefined, done: true });
    }
  }

  /** The stream failed — the loop throws. */
  abort(error: unknown): void {
    if (this.done || this.error) return;
    this.error = error;
    if (this.rejectNext) {
      const reject = this.rejectNext;
      this.resolveNext = this.rejectNext = null;
      reject(error);
    }
  }

  /** Pull the next result, waiting if nothing is ready yet. */
  next(): Promise<IteratorResult<T>> {
    if (this.chunks.length > 0) {
      return Promise.resolve({ value: this.chunks.shift()!, done: false });
    }
    if (this.error) return Promise.reject(this.error);
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.resolveNext = resolve;
      this.rejectNext = reject;
    });
  }
}
