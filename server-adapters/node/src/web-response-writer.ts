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

  writeHead(status: number, headers: Record<string, string>): this {
    this.headersSent = true;
    this.resolveAnswer(
      new Response(NULL_BODY_STATUSES.has(status) ? null : this.body, { status, headers }),
    );

    return this;
  }

  write(chunk: string): boolean {
    if (!this.finished) this.controller.enqueue(encoder.encode(chunk));

    return true;
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
    if (!this.finished) {
      this.finished = true;
      this.controller.error(new Error('[livething] response destroyed'));
    }

    this.emitCloseSoon();
    return this;
  }

  once(_event: 'close', listener: () => void): this {
    this.closeListeners.add(listener);
    return this;
  }

  off(_event: 'close', listener: () => void): this {
    this.closeListeners.delete(listener);
    return this;
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
