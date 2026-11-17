import {
  corsHeaders,
  ERROR_HEADER,
  errorAnswer,
  isStreamRequest,
  preflightAnswer,
  PROTOCOL_HEADER,
  SEQ_HEADER,
  SSE_HEADERS,
  sseCloseEvent,
  UPLOAD_HEADER,
} from '@livething/server/adapters';
import type {
  AuthDecision,
  ConnectionHandle,
  HttpAnswer,
  HttpHub,
  SseSink,
} from '@livething/server/adapters';
import type { IncomingHttpHeaders } from 'node:http';
import type { IncomingHttpHeaders as Http2IncomingHttpHeaders } from 'node:http2';
import { isSocketRejection, upgradeRejection } from './upgrade.ts';
import { gatesItsOwnWrites, onWriteGateFailure } from './write-gate.ts';
import type { ConnectionTransport } from './socket.ts';
import type { NodeWriteGate } from './write-gate.ts';

/** How long an HTTP/1.1 upload stopped early may go on sending after its answer. */
const DRAIN_MS = 2_000;

/**
 * A request `handle` takes: from `node:http`, from a `node:http2` compatibility server, or
 * the raw HTTP/2 stream that `handleStream` wraps. Only the members they all have.
 */
export interface NodeHttpRequest extends AsyncIterable<Buffer> {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: IncomingHttpHeaders | Http2IncomingHttpHeaders;
  readonly socket: { readonly remoteAddress?: string | undefined; readonly encrypted?: boolean };
  /** Whether the body was read to its end, or will not come. */
  readonly complete: boolean;
  /** Only on `node:http2`: the stream the request reads from. */
  readonly stream?: { close(): void };
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'error' | 'close' | 'aborted', listener: () => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  destroy(): unknown;
}

/**
 * A response `handle` writes: a `node:http` `ServerResponse`, or a `node:http2` compatibility
 * `Http2ServerResponse`. Only the members both have.
 */
export interface NodeHttpResponse {
  readonly headersSent: boolean;
  writeHead(status: number, headers: Record<string, string | string[]>): unknown;
  write(chunk: string | Uint8Array): boolean;
  end(): unknown;
  end(chunk: string): unknown;
  destroy(): unknown;
  once(event: 'close' | 'drain', listener: () => void): unknown;
  off(event: 'close' | 'drain', listener: () => void): unknown;
  /** Only on `node:http`. HTTP/2 sends the headers with `writeHead`. */
  flushHeaders?(): void;
  readonly writableLength?: number;
  /** Only on `node:http2`: the stream the response writes to. */
  readonly stream?: Corkable;
  /** On `node:http`, the TCP socket. `null` once the response is done. */
  readonly socket?: Corkable | null;
}

interface Corkable {
  cork(): void;
  uncork(): void;
}

/**
 * Where one event stream writes, with the events it holds until the end of this event loop
 * turn. A class, not closures: a connection holds it for its whole life.
 */
class HeldEvents implements SseSink {
  readonly response: NodeHttpResponse;
  /** The gate of the endpoint that accepts the stream. Set before the first event is held. */
  gate!: NodeWriteGate;
  chunks: Uint8Array[] = [];
  bytes = 0;

  constructor(response: NodeHttpResponse) {
    this.response = response;
  }

  get backpressureSupported(): boolean {
    return true;
  }

  write(chunk: Uint8Array): void {
    holdEvent(this, chunk);
  }

  end(): void {
    flush(this);
    this.response.end();
  }

  terminate(): void {
    flush(this);
    this.response.destroy();
  }

  bufferedAmount(): number {
    return (this.response.writableLength ?? 0) + this.bytes;
  }
}

/**
 * The event streams holding events. Every POST read in one turn can broadcast, and each
 * broadcast writes to every member. Held, a member gets them all as one write: one HTTP/1.1
 * chunk or HTTP/2 DATA frame and one system call, instead of one each. Corking alone does not
 * do that for small events: Node frames each write of a `node:http` response as its own chunk,
 * four socket writes each. So small events are copied into one write, and only big ones, where
 * the copy would cost more, go as corked writes. `setImmediate` runs once the turn has read its
 * I/O, so an event waits for no new I/O.
 */
const heldThisTurn = new Set<HeldEvents>();

/** A stream holding this many bytes sends them at once, as `ws` sockets do. */
const HOLD_BYTES = 64 * 1024;

/**
 * Held events smaller than this on average are copied into one write, which costs less than a
 * write for each. Bigger ones go as corked writes, with no copy.
 */
const COPY_BYTES = 1024;

function flushAll(): void {
  for (const held of heldThisTurn) flush(held);
}

onWriteGateFailure((gate) => {
  for (const held of heldThisTurn) {
    if (held.gate !== gate) continue;

    heldThisTurn.delete(held);
    held.chunks = [];
    held.bytes = 0;
    held.response.destroy();
  }
});

function flush(held: HeldEvents): void {
  if (held.chunks.length === 0) {
    heldThisTurn.delete(held);
    return;
  }

  // On a failed commit, the failure drop has already dropped this stream's events and ended it.
  if (!held.gate.commitBeforeWrite()) return;

  heldThisTurn.delete(held);
  const { chunks, bytes } = held;

  held.chunks = [];
  held.bytes = 0;
  const { response } = held;
  const corked = bytes >= chunks.length * COPY_BYTES ? (response.stream ?? response.socket) : null;
  if (chunks.length === 1) {
    response.write(chunks[0]!);
  } else if (corked) {
    // A corked HTTP/2 stream or TCP socket sends its writes together, with no copy.
    corked.cork();
    for (const chunk of chunks) response.write(chunk);
    corked.uncork();
  } else {
    response.write(Buffer.concat(chunks, bytes));
  }
}

function holdEvent(held: HeldEvents, chunk: Uint8Array): void {
  if (held.gate.failed) {
    held.response.destroy();
    return;
  }

  if (held.chunks.length === 0) {
    if (heldThisTurn.size === 0) setImmediate(flushAll);
    heldThisTurn.add(held);
  }

  held.chunks.push(chunk);
  held.bytes += chunk.byteLength;
  if (held.bytes >= HOLD_BYTES) flush(held);
}

/** What the http handler needs from its endpoint. */
export interface NodeHttpDeps {
  /** `null` when the endpoint does not offer `http()`. */
  hub: HttpHub | null;
  originAllowed(request: NodeHttpRequest): boolean;
  authenticate(request: NodeHttpRequest, signal: AbortSignal): Promise<AuthDecision>;
  attach(transport: ConnectionTransport, decision: AuthDecision): ConnectionHandle;
  /** Aborts when the endpoint shuts down, which ends a stream still in `authenticate`. */
  shutdownSignal: AbortSignal;
}

/** Serves the stream `GET`, its `POST`s and the CORS preflight of one endpoint. */
export function createNodeHttpHandler(
  deps: NodeHttpDeps,
): (request: NodeHttpRequest, response: NodeHttpResponse) => Promise<void> {
  return async (request, response) => {
    const { hub } = deps;
    const origin = header(request, 'origin');
    if (!deps.originAllowed(request)) {
      writeAnswer(response, errorAnswer(403, 'origin', 'Origin not allowed'));
      return;
    }

    const cors = corsHeaders(origin);
    const stream = isStreamRequest(
      header(request, 'accept'),
      header(request, PROTOCOL_HEADER.toLowerCase()),
    );
    if (!hub || (request.method === 'GET' && !stream)) {
      writeAnswer(response, errorAnswer(426, 'not-offered', 'Upgrade Required'), cors);
      return;
    }

    if (request.method === 'OPTIONS' && origin !== null) {
      writeAnswer(response, preflightAnswer(origin));
      return;
    }

    if (request.method === 'GET') {
      await openStream(deps, { hub, request, response, cors });
      return;
    }

    if (request.method === 'POST') {
      if (header(request, UPLOAD_HEADER.toLowerCase()) !== 'stream') {
        writeAnswer(response, await post(hub, request), cors);
        if (!request.complete) endBody(request, response);
        return;
      }

      // An upload lasts as long as the connection. Like the event stream, it returns at once and
      // is answered later, so no suspended `async` call holds memory for each connection.
      void upload(hub, request).then((answer) => {
        writeAnswer(response, answer, cors);
        if (!request.complete) endBody(request, response);
      });
      return;
    }

    writeAnswer(
      response,
      { ...errorAnswer(405, 'method'), headers: { [ERROR_HEADER]: 'method', Allow: 'GET, POST' } },
      cors,
    );
  };
}

interface StreamRequest {
  hub: HttpHub;
  request: NodeHttpRequest;
  response: NodeHttpResponse;
  cors: Record<string, string>;
}

async function openStream(deps: NodeHttpDeps, stream: StreamRequest): Promise<void> {
  const { hub, request, response, cors } = stream;
  if (deps.shutdownSignal.aborted) {
    writeAnswer(response, errorAnswer(503, 'shutting-down'), cors);
    return;
  }

  const abort = new AbortController();
  function stop(): void {
    abort.abort();
  }

  response.once('close', stop);
  deps.shutdownSignal.addEventListener('abort', stop);
  const aborted = new Promise<null>((resolve) => {
    abort.signal.addEventListener('abort', () => resolve(null), { once: true });
  });
  let decision: AuthDecision | null;
  try {
    const decided = deps.authenticate(request, abort.signal);
    decided.catch(() => {});
    // A hook that ignores the signal must not keep the stream, or a shutdown, waiting.
    decision = await Promise.race([decided, aborted]);
  } finally {
    response.off('close', stop);
    deps.shutdownSignal.removeEventListener('abort', stop);
  }

  if (decision === null || abort.signal.aborted) {
    if (deps.shutdownSignal.aborted && !response.headersSent) {
      writeAnswer(response, errorAnswer(503, 'shutting-down'), cors);
    }

    return;
  }

  if (decision.reject && !isSocketRejection(decision)) {
    const { status, body } = upgradeRejection(decision);
    writeAnswer(response, errorAnswer(status, 'auth', body), cors);
    return;
  }

  response.writeHead(200, { ...SSE_HEADERS, ...cors });
  if (decision.reject) {
    response.end(sseCloseEvent(decision.code!, decision.reason ?? 'Authentication rejected'));
    return;
  }

  // Send the headers now: the client waits for them before it reads any event.
  response.flushHeaders?.();
  const held = new HeldEvents(response);
  const opened = hub.openStream(held);
  response.once('close', () => opened.ended());
  const transport = gatesItsOwnWrites(opened.socket, (gate) => {
    held.gate = gate;
  });

  try {
    opened.attach(deps.attach(transport, decision));
  } catch (error) {
    response.destroy();
    throw error;
  }
}

async function post(hub: HttpHub, request: NodeHttpRequest): Promise<HttpAnswer> {
  const length = Number(header(request, 'content-length') ?? 0);
  if (length > hub.maxPostBytes) return errorAnswer(413, 'too-large');

  const started = hub.beginPost(
    header(request, 'livething-secret'),
    header(request, 'livething-lane'),
    header(request, SEQ_HEADER.toLowerCase()),
  );
  if (!('finish' in started)) return started;

  const body = await readBody(request, hub.maxPostBytes);
  if (body === null) {
    started.cancel();
    return errorAnswer(413, 'too-large');
  }

  if (body === undefined) {
    started.cancel();
    return errorAnswer(400, 'aborted');
  }

  return started.finish(body);
}

/**
 * The one long POST: each chunk goes to the hub as it arrives. While the hub has no room, the
 * request is paused, so the client's writes slow down through TCP or HTTP/2 flow control.
 */
function upload(hub: HttpHub, request: NodeHttpRequest): Promise<HttpAnswer> {
  const started = hub.beginUpload(header(request, 'livething-secret'));
  if (!('push' in started)) return Promise.resolve(started);

  const uploading = started;
  return new Promise((resolve) => {
    let done = false;
    function settle(answer: HttpAnswer): void {
      if (done) return;

      done = true;
      request.off('data', onData);
      resolve(answer);
    }

    function onData(chunk: Buffer): void {
      const wait = uploading.push(chunk);
      if (!wait) return;

      request.pause();
      void wait.then(() => {
        if (!done) request.resume();
      });
    }

    function broke(): void {
      if (done) return;

      uploading.cancel();
      settle(errorAnswer(400, 'aborted'));
    }

    // `on`, not `once`: each `once` wraps its listener in a bound function and a state object,
    // and they stay for the whole upload. `settle` and `broke` run once anyway.
    request.on('data', onData);
    request.on('end', () => settle(uploading.finish()));
    request.on('error', broke);
    request.on('close', broke);
    // An HTTP/2 stream reset ends a compatibility request with `aborted`, not always `close`.
    request.on('aborted', broke);
    void uploading.stopped.then((answer) => {
      request.pause();
      settle(answer);
    });
  });
}

/**
 * Ends the body of an upload that was stopped while the client still sends. HTTP/2 resets the
 * stream with NO_ERROR after the answer. HTTP/1.1 has no such reset: closing the socket at once
 * makes the OS send RST, and the client loses the answer. So it reads and drops the rest, and
 * closes the connection only when the body has not ended `DRAIN_MS` after the answer.
 */
function endBody(request: NodeHttpRequest, response: NodeHttpResponse): void {
  if (request.stream) {
    setImmediate(resetUnended, request);
    return;
  }

  request.resume();
  response.once('close', () => {
    setTimeout(() => {
      if (!request.complete) request.destroy();
    }, DRAIN_MS).unref();
  });
}

/**
 * Resets an HTTP/2 stream whose body has not ended, one turn after the answer. A client that
 * stops with a close frame ends its body right after it, and that stream then closes with no reset.
 */
function resetUnended(request: NodeHttpRequest): void {
  if (!request.complete) request.stream?.close();
}

/** The body, `null` when it is over the limit, or `undefined` when it did not arrive whole. */
// Events, not `for await`: an async iterator for each POST costs more than reading its body.
function readBody(request: NodeHttpRequest, limit: number): Promise<Uint8Array | null | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    function settle(result: Uint8Array | null | undefined): void {
      if (done) return;

      done = true;
      request.off('data', onData);
      resolve(result);
    }

    function onData(chunk: Buffer): void {
      size += chunk.byteLength;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }

      // Not `request.destroy()`: on HTTP/1.1 that resets the socket, and the client never sees
      // the 413. The caller drops the rest of the body after the answer, with `endBody`.
      settle(null);
    }

    function broke(): void {
      settle(undefined);
    }

    request.on('data', onData);
    request.on('end', () => {
      if (done) return;

      const body = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
      settle(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    });
    request.on('error', broke);
    request.on('close', broke);
    request.on('aborted', broke);
  });
}

function header(request: NodeHttpRequest, name: string): string | null {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

function writeAnswer(
  response: NodeHttpResponse,
  answer: HttpAnswer,
  extra: Record<string, string> = {},
): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(answer.status, { ...answer.headers, ...extra });
  if (answer.body === null) {
    response.end();
  } else {
    response.end(answer.body);
  }
}
