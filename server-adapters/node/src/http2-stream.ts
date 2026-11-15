import type { IncomingHttpHeaders, ServerHttp2Stream } from 'node:http2';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { NodeHttpRequest, NodeHttpResponse } from './http.ts';

function ignore(): void {}

/** Headers about one HTTP/1.1 connection, which an HTTP/2 response must not carry. */
const CONNECTION_HEADERS = new Set([
  'connection',
  'http2-settings',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
]);

/**
 * One raw HTTP/2 stream as the request and the response `handle` takes. A `node:http2` server
 * with no `request` listener makes no compatibility objects for its streams, and this one small
 * object takes the place of both: about 2 KB less for each open stream, and less work for each
 * POST.
 */
export class StreamExchange implements NodeHttpRequest, NodeHttpResponse {
  readonly stream: ServerHttp2Stream;
  readonly headers: IncomingHttpHeaders;
  readonly socket: Socket | TLSSocket;

  constructor(stream: ServerHttp2Stream, headers: IncomingHttpHeaders) {
    this.stream = stream;
    this.headers = headers;
    // `handleStream` checks that the session is there; it goes when the stream closes.
    this.socket = stream.session!.socket;
    // A stream reset by the client emits `error`. The compatibility response ignores it too.
    stream.on('error', ignore);
  }

  get method(): string | undefined {
    return this.headers[':method'];
  }

  get url(): string | undefined {
    return this.headers[':path'];
  }

  get complete(): boolean {
    const { stream } = this;
    return stream.readableEnded || stream.closed || stream.destroyed;
  }

  get headersSent(): boolean {
    return this.stream.headersSent;
  }

  get writableLength(): number {
    return this.stream.writableLength;
  }

  on(event: string, listener: (chunk: Buffer) => void): this {
    this.stream.on(event, listener);
    return this;
  }

  once(event: string, listener: () => void): this {
    this.stream.once(event, listener);
    return this;
  }

  off(event: string, listener: (chunk: Buffer) => void): this {
    this.stream.off(event, listener);
    return this;
  }

  pause(): this {
    this.stream.pause();
    return this;
  }

  resume(): this {
    this.stream.resume();
    return this;
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return this.stream[Symbol.asyncIterator]();
  }

  writeHead(status: number, headers: Record<string, string | string[]>): this {
    const { stream } = this;
    // A stream the client already reset takes no headers, as on a compatibility response.
    if (stream.destroyed || stream.closed) return this;

    const sent: Record<string, string | string[] | number> = { ':status': status };
    for (const [name, value] of Object.entries(headers)) {
      // HTTP/2 refuses these, so a response passed on from HTTP/1.1 goes out without them.
      const lower = name.toLowerCase();
      if (CONNECTION_HEADERS.has(lower) || (lower === 'te' && value !== 'trailers')) continue;

      sent[name] = value;
    }

    stream.respond(sent);

    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    return this.stream.write(chunk);
  }

  end(chunk?: string): this {
    if (chunk === undefined) this.stream.end();
    else this.stream.end(chunk);

    return this;
  }

  destroy(): this {
    this.stream.destroy();
    return this;
  }
}
