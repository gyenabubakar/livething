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
import { CloseCodes } from '@livething/server/errors';
import type {
  AuthDecision,
  ConnectionHandle,
  HttpAnswer,
  HttpHub,
  SseStream,
} from '@livething/server/adapters';

const MiB = 1024 * 1024;

/**
 * How many unread bytes the streams of one object may hold. An object has 128 MB of memory,
 * and a client that stopped reading keeps everything sent to it there. One stream must fit
 * one message: 32 MiB of bytes is about 43 MiB as base64.
 */
interface UnreadCaps {
  streamBytes: number;
  objectBytes: number;
}

const DEFAULT_CAPS: UnreadCaps = { streamBytes: 48 * MiB, objectBytes: 64 * MiB };

/** What the http handler needs from its Durable Object. */
export interface CloudflareHttpDeps {
  /** `null` when the object does not offer server-sent events. */
  hub: HttpHub | null;
  originAllowed(request: Request): boolean;
  authenticate(request: Request): Promise<AuthDecision>;
  attach(socket: SseStream['socket'], decision: AuthDecision): ConnectionHandle;
  caps?: UnreadCaps;
}

/** An open stream, as the object's caps see it. */
interface UploadStop {
  answer: HttpAnswer | null;
}

interface LiveStream {
  unread(): number;
  drop(): void;
}

interface StreamDeps extends CloudflareHttpDeps {
  hub: HttpHub;
  caps: UnreadCaps;
  live: Set<LiveStream>;
}

/** Serves the stream `GET`, its `POST`s and the CORS preflight of one Durable Object. */
export function createCloudflareHttpHandler(
  deps: CloudflareHttpDeps,
): (request: Request) => Promise<Response> {
  const caps = deps.caps ?? DEFAULT_CAPS;
  const live = new Set<LiveStream>();

  return async (request) => {
    const { hub } = deps;
    const origin = request.headers.get('Origin');
    if (!deps.originAllowed(request)) {
      return toResponse(errorAnswer(403, 'origin', 'Origin not allowed'));
    }

    const cors = corsHeaders(origin);
    const stream = isStreamRequest(
      request.headers.get('Accept'),
      request.headers.get(PROTOCOL_HEADER),
    );
    if (!hub || (request.method === 'GET' && !stream)) {
      return toResponse(errorAnswer(426, 'not-offered', 'Upgrade Required'), cors);
    }

    if (request.method === 'OPTIONS' && origin !== null) {
      return toResponse(preflightAnswer(origin));
    }

    if (request.method === 'GET') return openStream({ ...deps, hub, caps, live }, request, cors);

    if (request.method === 'POST') {
      const uploading = request.headers.get(UPLOAD_HEADER) === 'stream';
      return toResponse(await (uploading ? upload(hub, request) : post(hub, request)), cors);
    }

    return toResponse(
      { ...errorAnswer(405, 'method'), headers: { [ERROR_HEADER]: 'method', Allow: 'GET, POST' } },
      cors,
    );
  };
}

async function openStream(
  deps: StreamDeps,
  request: Request,
  cors: Record<string, string>,
): Promise<Response> {
  const { hub, caps, live } = deps;
  const decision = await deps.authenticate(request);
  // >= 1000 is a close code, which the stream reports; below that, an HTTP status.
  if (decision.reject && !(decision.code !== undefined && decision.code >= 1000)) {
    const status =
      decision.code !== undefined && decision.code >= 400 && decision.code <= 599
        ? decision.code
        : 403;
    return toResponse(
      errorAnswer(status, 'auth', decision.reason ?? 'Authentication rejected'),
      cors,
    );
  }

  const headers = { ...SSE_HEADERS, ...cors };
  if (decision.reject) {
    return new Response(
      sseCloseEvent(decision.code!, decision.reason ?? 'Authentication rejected'),
      {
        headers,
      },
    );
  }

  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let state: 'open' | 'ending' | 'done' = 'open';
  let opened: SseStream | null = null;
  // With a high-water mark of 0, `-desiredSize` is the bytes the client has not read yet.
  const body = new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
      },
      // The runtime pulls only when the client has read everything queued.
      pull() {
        if (state !== 'ending') return;

        finish();
        controller.close();
      },
      // Local workerd never calls this (it does not report a client abort); keepalive covers it.
      cancel() {
        finish();
        opened?.ended();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
  );

  function unread(): number {
    return state === 'done' ? 0 : Math.max(0, -(controller.desiredSize ?? 0));
  }

  function finish(): void {
    state = 'done';
    live.delete(stream);
  }

  function terminate(): void {
    if (state === 'done') return;

    finish();
    controller.error(new Error('[livething] the client stopped reading'));
  }

  const stream: LiveStream = {
    unread,
    // The engine's slow-client close, at once. The stream stops first, so the close frame is
    // not queued behind data the client will never read.
    drop() {
      terminate();
      opened?.socket.close(CloseCodes.TRY_AGAIN_LATER, '[livething] the client reads too slowly');
    },
  };

  live.add(stream);

  /** Whether `bytes` more fit the caps. If not, drops the stream with the most unread bytes. */
  function fits(bytes: number): boolean {
    const own = unread() + bytes;
    if (own > caps.streamBytes) {
      stream.drop();
      return false;
    }

    // ponytail: sums every stream of the object on each write; fine for a few hundred streams.
    let total = 0;
    let largest = stream;
    let largestBytes = own;
    for (const other of live) {
      const size = other === stream ? own : other.unread();
      total += size;
      if (size > largestBytes) {
        largest = other;
        largestBytes = size;
      }
    }

    if (total <= caps.objectBytes) return true;

    largest.drop();

    return largest !== stream;
  }

  opened = hub.openStream({
    write(chunk) {
      if (state !== 'open') return;

      const bytes = encoder.encode(chunk);
      if (fits(bytes.byteLength)) controller.enqueue(bytes);
    },
    // Ends after the client reads what is queued, so the `__close__` frame reaches it.
    end() {
      if (state !== 'open') return;

      state = 'ending';
      if (unread() === 0) {
        finish();
        controller.close();
      }
    },
    terminate,
    bufferedAmount: unread,
    backpressureSupported: true,
  });
  try {
    opened.attach(deps.attach(opened.socket, decision));
  } catch (error) {
    terminate();
    throw error;
  }

  return new Response(body, { headers });
}

async function post(hub: HttpHub, request: Request): Promise<HttpAnswer> {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > hub.maxPostBytes) return errorAnswer(413, 'too-large');

  const started = hub.beginPost(
    request.headers.get('LiveThing-Secret'),
    request.headers.get('LiveThing-Lane'),
    request.headers.get(SEQ_HEADER),
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
 * The one long POST: each chunk goes to the hub as it arrives, and the next `read()` waits
 * while the hub has no room. Whether the edge passes the body on as it streams, and not
 * whole, only the client's probe can tell.
 */
async function upload(hub: HttpHub, request: Request): Promise<HttpAnswer> {
  const started = hub.beginUpload(request.headers.get('LiveThing-Secret'));
  if (!('push' in started)) return started;

  if (!request.body) return started.finish();

  const reader = request.body.getReader();
  const stop: UploadStop = { answer: null };
  void started.stopped.then((answer) => {
    stop.answer = answer;
    void reader.cancel().catch(() => {});
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (stop.answer) return stop.answer;

      if (done) return started.finish();

      const wait = started.push(value);
      if (wait) await wait;
    }
  } catch {
    if (stop.answer) return stop.answer;

    started.cancel();
    return errorAnswer(400, 'aborted');
  }
}

/** The body, `null` when it is over the limit, or `undefined` when it did not arrive whole. */
async function readBody(request: Request, limit: number): Promise<Uint8Array | null | undefined> {
  if (!request.body) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }

      chunks.push(value);
    }
  } catch {
    return undefined;
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function toResponse(answer: HttpAnswer, extra: Record<string, string> = {}): Response {
  return new Response(answer.body, {
    status: answer.status,
    headers: { ...answer.headers, ...extra },
  });
}
