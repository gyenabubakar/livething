import type { NodeHttpResponse } from './sse.ts';

const encoder = new TextEncoder();
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A {@link NodeHttpResponse} that a web framework can return: `answer` resolves with a web
 * `Response` at `writeHead`, and its body streams what the SSE handler writes after that.
 * `writableLength` is what the framework has not read from the body yet.
 */
export class WebResponseWriter implements NodeHttpResponse {
  headersSent = false;
  readonly answer: Promise<Response>;
  private resolveAnswer!: (response: Response) => void;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly body: ReadableStream<Uint8Array>;
  /** No more writes: the body ended, failed, or the client left. */
  private finished = false;
  private closed = false;
  private readonly closeListeners = new Set<() => void>();
  private readonly drainListeners = new Set<() => void>();

  /** `signal` aborts when the client leaves before the answer is sent. */
  constructor(signal: AbortSignal) {
    this.answer = new Promise((resolve) => {
      this.resolveAnswer = resolve;
    });
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        // The framework asks for more only once it has read everything queued.
        pull: () => this.emitDrain(),
        cancel: () => this.clientLeft(),
      },
      { highWaterMark: 0, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    if (signal.aborted) this.clientLeft();
    else signal.addEventListener('abort', () => this.clientLeft(), { once: true });
  }

  get writableLength(): number {
    return Math.max(0, -(this.controller.desiredSize ?? 0));
  }

  writeHead(status: number, headers: Record<string, string | string[]>): this {
    this.headersSent = true;
    const webHeaders = new Headers();
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) webHeaders.append(name, item);
    }

    this.resolveAnswer(
      new Response(NULL_BODY_STATUSES.has(status) ? null : this.body, {
        status,
        headers: webHeaders,
      }),
    );

    return this;
  }

  /** Like Node's `write`: `false` while the framework has not read everything queued yet. */
  write(chunk: string | Uint8Array): boolean {
    if (!this.finished) {
      this.controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    }

    return this.finished || this.writableLength === 0;
  }

  end(chunk?: string): this {
    if (chunk !== undefined) this.write(chunk);

    if (!this.finished) {
      this.finished = true;
      this.controller.close();
    }

    this.emitCloseSoon();
    return this;
  }

  destroy(): this {
    // The framework waits for an answer, so a request ended before its headers still gets one.
    if (!this.headersSent) this.writeHead(503, {});

    if (!this.finished) {
      this.finished = true;
      this.controller.error(new Error('[livething] response destroyed'));
    }

    this.emitCloseSoon();
    return this;
  }

  once(event: 'close' | 'drain', listener: () => void): this {
    (event === 'drain' ? this.drainListeners : this.closeListeners).add(listener);
    return this;
  }

  off(event: 'close' | 'drain', listener: () => void): this {
    (event === 'drain' ? this.drainListeners : this.closeListeners).delete(listener);
    return this;
  }

  private emitDrain(): void {
    const listeners = [...this.drainListeners];
    this.drainListeners.clear();
    for (const listener of listeners) listener();
  }

  /** Answers 500 when the handler failed before it sent an answer. */
  fail(): void {
    if (this.headersSent) {
      this.destroy();
      return;
    }

    this.writeHead(500, {});
    this.end();
  }

  private clientLeft(): void {
    this.finished = true;
    // Nothing writes for a client that left, and the framework must not wait forever.
    if (!this.headersSent) this.resolveAnswer(new Response(null, { status: 503 }));

    this.emitClose();
  }

  /** Node emits `close` after `end()` returns, and the SSE handler counts on that order. */
  private emitCloseSoon(): void {
    queueMicrotask(() => this.emitClose());
  }

  private emitClose(): void {
    if (this.closed) return;

    this.closed = true;
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) listener();
  }
}
