import { EventEmitter } from 'node:events';
import { http, websocket } from '@livething/server/adapters';
import WebSocket from 'ws';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { RawData } from 'ws';
import type { NodeServerEndpointOptions } from './setup.ts';
import type * as Socket from './socket.ts';
import type { ConnectionTransport } from './socket.ts';

/** Whether a message is the `__connected__` frame the engine sends first on every connection. */
export function isConnectedFrame(data: RawData, isBinary: boolean): boolean {
  return !isBinary && data.toString().startsWith('["__connected__"');
}

/**
 * The next message a ws client gets, with whether it came as a binary message. It skips
 * the `__connected__` frame, which the specs that use it do not test.
 */
export function nextRawMessage(socket: WebSocket): Promise<{ data: RawData; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    function onMessage(data: RawData, isBinary: boolean): void {
      if (isConnectedFrame(data, isBinary)) return;

      socket.off('message', onMessage);
      socket.off('error', reject);
      resolve({ data, isBinary });
    }

    socket.on('message', onMessage);
    socket.once('error', reject);
  });
}

/** The next message a ws client gets, parsed as JSON, after the `__connected__` frame. */
export async function nextJsonMessage<T>(socket: WebSocket): Promise<T> {
  const { data } = await nextRawMessage(socket);

  return JSON.parse(data.toString()) as T;
}

/** One connection a test watched: the transport its adapter built, and the binary messages the engine got. */
export interface CapturedBridge {
  transport: ConnectionTransport;
  binaryMessages: Uint8Array[];
}

export const capturedBridges: CapturedBridge[] = [];

/**
 * A `./socket.ts` whose bridge records each transport and each binary message. Return it from
 * `vi.mock` so a test can see what the engine got and send through the adapter's real transport.
 */
export function captureBridges(socket: typeof Socket): typeof Socket {
  return {
    ...socket,
    createConnectionBridge(options) {
      const handle = socket.createConnectionBridge(options);
      const bridge: CapturedBridge = { transport: options.transport, binaryMessages: [] };
      capturedBridges.push(bridge);

      return {
        ...handle,
        handleBinaryMessage(data) {
          bridge.binaryMessages.push(data);
          return handle.handleBinaryMessage(data);
        },
      };
    },
  };
}

/**
 * The transport the adapter specs run their raw clients over. The `http` vitest project
 * sets `LIVETHING_TEST_TRANSPORT=http`, so the same specs run once over each transport.
 */
type RawTransport = 'websocket' | 'http';

export const rawTransport: RawTransport =
  process.env.LIVETHING_TEST_TRANSPORT === 'http' ? 'http' : 'websocket';

/** The endpoint options that serve {@link rawTransport}. Spread them into `bind()`. */
export const rawTransportOptions: Pick<NodeServerEndpointOptions, 'transports'> =
  rawTransport === 'http' ? { transports: [websocket(), http()] } : {};

interface HandlingEndpoint {
  handle(request: IncomingMessage, response: ServerResponse): void;
}

/** The HTTP listener for a spec's server: the endpoint's `handle` over SSE, else 404. */
export function rawRequestListener(endpoint: HandlingEndpoint): RequestListener {
  return (request, response) => {
    if (rawTransport === 'http') {
      endpoint.handle(request, response);
      return;
    }

    response.statusCode = 404;
    response.end();
  };
}

interface RawClientOptions {
  headers?: Record<string, string>;
  /** WebSocket only: `false` asks for no compression. */
  perMessageDeflate?: boolean;
}

/**
 * Opens a raw client at an `http:` or `ws:` URL over {@link rawTransport}. The SSE client
 * has the part of the `ws` API that the specs use (`readyState`, `send`, `close`, and the
 * `open`, `message`, `close` and `error` events), so it is typed as a `ws` WebSocket.
 */
export function openRawClient(url: string, options: RawClientOptions = {}): WebSocket {
  if (rawTransport === 'websocket') {
    return new WebSocket(url.replace(/^http/, 'ws'), {
      headers: options.headers,
      ...(options.perMessageDeflate === false ? { perMessageDeflate: false } : {}),
    });
  }

  return new HttpRawClient(url.replace(/^ws/, 'http'), options) as unknown as WebSocket;
}

const TEXT_FRAME = 0;
const BINARY_FRAME = 1;

class HttpRawClient extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  private secret = '';
  private readonly stream = new AbortController();
  private dataLane: Promise<void> = Promise.resolve();
  private dataSeq = 0;

  constructor(
    private readonly url: string,
    options: RawClientOptions,
  ) {
    super();
    void this.read(options);
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error('The SSE raw client is not open');

    this.dataLane = this.dataLane.then(() => this.post('data', data)).catch(() => {});
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= WebSocket.CLOSING) return;

    if (this.readyState === WebSocket.CONNECTING) {
      this.finish(1006, '');
      return;
    }

    this.readyState = WebSocket.CLOSING;
    const frame = JSON.stringify(['__close__', { code, reason }, null]);
    void this.dataLane
      .then(() => this.post('control', frame))
      .catch(() => {})
      .then(() => this.finish(code, reason));
  }

  terminate(): void {
    this.finish(1006, '');
  }

  private async read(options: RawClientOptions): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        headers: {
          ...options.headers,
          Accept: 'text/event-stream',
          'LiveThing-Protocol': 'livething-v1',
        },
        signal: this.stream.signal,
      });
    } catch (error) {
      this.fail(error);
      return;
    }

    if (!response.ok || !response.body) {
      this.emit('unexpected-response', response);
      this.fail(new Error(`Unexpected server response: ${response.status}`));
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          this.handleEvent(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    } catch {
      // An abort is a close that already ran. Any other read error ends the stream below.
    }

    // After our own `__close__`, the server ends the stream before its POST answer comes.
    if (this.readyState !== WebSocket.CLOSING) this.finish(1006, '');
  }

  private handleEvent(block: string): void {
    if (this.readyState === WebSocket.CLOSED) return;

    const text = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
      .join('\n');
    if (text === '') return;

    if (text === 'ping') {
      void this.post('control', 'pong').catch(() => {});
      return;
    }

    if (text.startsWith('b')) {
      this.emit('message', Buffer.from(text.slice(1), 'base64'), true);
      return;
    }

    if (text.startsWith('["__close__"')) {
      const [, payload] = JSON.parse(text) as [string, { code: number; reason: string }];
      this.finish(payload.code, payload.reason);
      return;
    }

    if (this.readyState === WebSocket.CONNECTING && text.startsWith('["__connected__"')) {
      this.secret = (JSON.parse(text) as [string, { secret: string }])[1].secret;
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    }

    this.emit('message', Buffer.from(text), false);
  }

  private async post(lane: 'data' | 'control', data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const body = new Uint8Array(5 + bytes.byteLength);
    body[0] = typeof data === 'string' ? TEXT_FRAME : BINARY_FRAME;
    new DataView(body.buffer).setUint32(1, bytes.byteLength);
    body.set(bytes, 5);

    // Data POSTs go one at a time, so each is the next frame in the sequence. The number moves
    // on only when the server took the frame, so a failed POST does not leave a gap.
    const next = this.dataSeq + 1;
    const seq = lane === 'data' ? { 'LiveThing-Seq': String(next) } : {};
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'LiveThing-Secret': this.secret,
        'LiveThing-Lane': lane,
        ...seq,
      },
      body,
    });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`POST answered ${response.status}`);

    if (lane === 'data') this.dataSeq = next;
  }

  private fail(error: unknown): void {
    if (this.readyState === WebSocket.CLOSED) return;

    this.emit('error', error);
    this.finish(1006, '');
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return;

    this.readyState = WebSocket.CLOSED;
    this.stream.abort();
    this.emit('close', code, Buffer.from(reason));
  }
}
