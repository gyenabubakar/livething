import { CloseCodes, encodeBase64, splitBinaryFrame } from '@livething/core';
import { isProtocolEventName } from '~/_engine/runtime/protocol.ts';
import type { ConnectionHandle, SocketDescriptor, TransportFrame } from './types.ts';

/** The headers of a server-sent events response. `no-transform` stops a proxy compressing it. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no',
};

/** The header that marks an error response as LiveThing's own, not a proxy's. */
export const ERROR_HEADER = 'LiveThing-Error';

/** One answer to an HTTP request of the SSE transport. */
export interface SseAnswer {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

/** The most frames one connection may have handed to the engine and not yet finished. */
const MAX_IN_FLIGHT_FRAMES = 255;

/** How long a client waits after a busy answer before it sends again. */
const BUSY_RETRY_AFTER_MS = 250;

const TEXT_FRAME = 0;
const BINARY_FRAME = 1;
const FRAME_HEADER_BYTES = 5;

/** A close with no close frame, as a WebSocket reports a dropped connection. */
const ABNORMAL_CLOSE = 1006;

/** One `data:` event for a frame. A binary frame is `b` and the whole frame in base64. */
function sseEvent(frame: TransportFrame): string {
  return frame.kind === 'text'
    ? `data: ${frame.text}\n\n`
    : `data: b${encodeBase64(frame.bytes)}\n\n`;
}

/** The last event of a stream: the close code and reason, because SSE has no close frame. */
export function sseCloseEvent(code: number, reason: string): string {
  return `data: ${JSON.stringify(['__close__', { code, reason }, null])}\n\n`;
}

/** An error answer that the client can tell apart from a proxy's. */
export function errorAnswer(status: number, error: string, body: string | null = null): SseAnswer {
  return {
    status,
    headers: {
      [ERROR_HEADER]: error,
      ...(body === null ? {} : { 'Content-Type': 'text/plain; charset=utf-8' }),
    },
    body,
  };
}

/** A random 256-bit connection secret, base64url. A POST sends it to name its connection. */
function createSecret(): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(32)), true);
}

/** Where a stream writes. The adapter makes one for each open response. */
export interface SseSink {
  write(chunk: string): void;
  end(): void;
  /** Drop the response at once, for a client that stopped reading. */
  terminate?(): void;
  /** The bytes written and not yet sent. */
  bufferedAmount(): number;
  backpressureSupported: boolean;
}

/** One open stream, before and after the engine accepts its connection. */
export interface SseStream {
  /** The socket descriptor fields for `engine.accept`. */
  readonly socket: Omit<SocketDescriptor, 'send' | 'backpressureSupported'> & {
    /** `false` once the stream is closed. */
    send(frame: TransportFrame): boolean;
    backpressureSupported: boolean;
    secret: string;
    maxPostBytes: number;
  };
  /** Give the stream its engine connection, once accepted. POSTs reach it from now on. */
  attach(handle: ConnectionHandle): void;
  /** The adapter saw the response end without a close from either side. */
  ended(): void;
}

interface Session {
  handle: ConnectionHandle;
  lanes: { data: boolean; control: boolean };
  inFlightFrames: number;
  inFlightBytes: number;
  close(code: number, reason: string): void;
  closeFromClient(code: number, reason: string): void;
}

/** A POST whose headers passed. The adapter reads the body, then calls `finish` or `cancel`. */
export interface SsePost {
  finish(body: Uint8Array): SseAnswer;
  /** The body could not be read: clear the lane so the next POST is not refused. */
  cancel(): void;
}

interface Frame {
  type: number;
  data: Uint8Array;
  text?: string;
  /** Whether the frame waits in line, so it counts against the connection's room. */
  counted: boolean;
}

/** The secret-to-connection map and the POST rules shared by every adapter. */
export interface SseHub {
  readonly maxPostBytes: number;
  openStream(sink: SseSink): SseStream;
  /** Check a POST's secret and lane before its body is read. */
  beginPost(secret: string | null, lane: string | null): SsePost | SseAnswer;
}

export interface SseHubOptions {
  maxPostBytes: number;
  /** The engine's receive limit. Frames in flight may hold this many bytes, half its budget. */
  receiveBytes: number;
}

/** The SSE module of one endpoint. */
export function createSseHub(options: SseHubOptions): SseHub {
  const { maxPostBytes, receiveBytes } = options;
  const sessions = new Map<string, Session>();

  function openStream(sink: SseSink): SseStream {
    const secret = createSecret();
    let handle: ConnectionHandle | null = null;
    let closed = false;

    function finish(code: number, reason: string): void {
      closed = true;
      sessions.delete(secret);
      // The engine is the caller of `close`, so it hears about the close a moment later.
      const current = handle;
      if (current) queueMicrotask(() => void current.handleClose(code, reason));
    }

    function close(code: number = CloseCodes.NORMAL, reason = ''): void {
      if (closed) return;

      sink.write(sseCloseEvent(code, reason));
      sink.end();
      finish(code, reason);
    }

    return {
      socket: {
        // `false` only for a closed stream: a full buffer still delivers, and replay counts it.
        send(frame) {
          if (closed) return false;

          sink.write(sseEvent(frame));
          return true;
        },
        close,
        ...(sink.terminate ? { terminate: () => sink.terminate?.() } : {}),
        bufferedAmount: () => sink.bufferedAmount(),
        backpressureSupported: sink.backpressureSupported,
        secret,
        maxPostBytes,
      },
      attach(connection) {
        handle = connection;
        if (closed) return;

        sessions.set(secret, {
          handle: connection,
          lanes: { data: false, control: false },
          inFlightFrames: 0,
          inFlightBytes: 0,
          close,
          closeFromClient(code, reason) {
            if (closed) return;

            sink.end();
            finish(code, reason);
          },
        });
      },
      ended() {
        if (!closed) finish(ABNORMAL_CLOSE, 'stream ended');
      },
    };
  }

  function beginPost(secret: string | null, laneName: string | null): SsePost | SseAnswer {
    const found = secret === null ? undefined : sessions.get(secret);
    if (!found) return errorAnswer(404, 'unknown-connection');

    const session = found;

    if (laneName !== 'data' && laneName !== 'control') {
      session.close(CloseCodes.PROTOCOL_ERROR, 'bad LiveThing-Lane header');
      return errorAnswer(400, 'bad-lane');
    }

    const lane = laneName;
    if (session.lanes[lane]) {
      session.close(CloseCodes.PROTOCOL_ERROR, 'two POSTs at once in one lane');
      return errorAnswer(409, 'lane-busy');
    }

    session.lanes[lane] = true;
    let done = false;
    function clearLane(): void {
      if (done) return;

      done = true;
      session.lanes[lane] = false;
    }

    return {
      cancel: clearLane,
      finish(body) {
        // Every exit clears the lane in this tick, before the answer is written, so the
        // client's next POST in the lane is never refused as a second one.
        const answer =
          lane === 'control' ? deliverControl(session, body) : deliverData(session, body);
        clearLane();
        return answer;
      },
    };
  }

  function deliverControl(session: Session, body: Uint8Array): SseAnswer {
    const frames = parseBatch(body);
    const texts = frames?.map((frame) => frame.text);
    const allowed = texts?.every(
      (text) => text === 'ping' || text === 'pong' || readClose(text) !== null,
    );
    if (!texts || !allowed) {
      session.close(CloseCodes.PROTOCOL_ERROR, 'bad control POST');
      return errorAnswer(400, 'bad-batch');
    }

    for (const text of texts) {
      const close = readClose(text);
      if (close) {
        session.closeFromClient(close.code, close.reason);
        break;
      }

      void session.handle.handleMessage(text!);
    }

    return NO_CONTENT;
  }

  function deliverData(session: Session, body: Uint8Array): SseAnswer {
    const frames = parseBatch(body);
    if (!frames) {
      session.close(CloseCodes.PROTOCOL_ERROR, 'bad POST batch');
      return errorAnswer(400, 'bad-batch');
    }

    const room = roomFor(session, frames);
    if (room < frames.length) {
      return {
        status: 503,
        headers: { [ERROR_HEADER]: 'busy', 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, retryAfterMs: BUSY_RETRY_AFTER_MS }),
      };
    }

    for (const frame of frames) handOver(session, frame);

    return NO_CONTENT;
  }

  /** How many leading frames of a batch fit beside the frames already in flight. */
  function roomFor(session: Session, frames: readonly Frame[]): number {
    let count = session.inFlightFrames;
    let bytes = session.inFlightBytes;
    for (const [index, frame] of frames.entries()) {
      if (!frame.counted) continue;

      count++;
      bytes += frame.data.byteLength;
      if (count > MAX_IN_FLIGHT_FRAMES || bytes > receiveBytes) return index;
    }

    return frames.length;
  }

  function handOver(session: Session, frame: Frame): void {
    const { handle } = session;
    const result =
      frame.type === BINARY_FRAME
        ? handle.handleBinaryMessage(frame.data)
        : handle.handleMessage(frame.text!);
    if (!frame.counted) return;

    session.inFlightFrames++;
    session.inFlightBytes += frame.data.byteLength;
    void result
      .catch(() => {})
      .finally(() => {
        session.inFlightFrames--;
        session.inFlightBytes -= frame.data.byteLength;
      });
  }

  return { maxPostBytes, openStream, beginPost };
}

const NO_CONTENT: SseAnswer = { status: 204, headers: {}, body: null };

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Split a POST body into frames: 1 byte for the type (0 text, 1 binary), 4 bytes for the
 * length, then the data. `null` when the body does not parse.
 */
function parseBatch(body: Uint8Array): Frame[] | null {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const frames: Frame[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    if (offset + FRAME_HEADER_BYTES > body.byteLength) return null;

    const type = body[offset]!;
    const length = view.getUint32(offset + 1, false);
    const start = offset + FRAME_HEADER_BYTES;
    if ((type !== TEXT_FRAME && type !== BINARY_FRAME) || start + length > body.byteLength) {
      return null;
    }

    const data = body.subarray(start, start + length);
    if (type === TEXT_FRAME) {
      let text: string;
      try {
        text = textDecoder.decode(data);
      } catch {
        return null;
      }

      frames.push({ type, data, text, counted: waitsInLine(parseJson(text), false) });
    } else {
      const split = splitBinaryFrame(data);
      const envelope = split.kind === 'frame' ? parseJson(split.envelope) : undefined;
      frames.push({ type, data, counted: waitsInLine(envelope, true) });
    }

    offset = start + length;
  }

  return frames;
}

function parseJson(text: string): unknown {
  if (text === 'ping' || text === 'pong') return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Whether the engine counts a frame as waiting in line: an app event, or a text
 * `__subscribe__`. This mirrors the engine's rule, with one difference: the module cannot
 * know which server requests are still waiting, so it never counts a frame that says it
 * answers one. The engine still checks those itself.
 */
function waitsInLine(parsed: unknown, binary: boolean): boolean {
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return false;

  if (isProtocolEventName(parsed[0])) return !binary && parsed[0] === '__subscribe__';

  const exchange = (parsed[2] as { exchange?: { source?: unknown } } | null)?.exchange;
  return exchange?.source !== 'server';
}

/** The code and reason of a client's `__close__` frame, or `null` for any other text. */
function readClose(text: string | undefined): { code: number; reason: string } | null {
  if (text === undefined || !text.startsWith('["__close__"')) return null;

  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) return null;

  const payload = parsed[1] as { code?: unknown; reason?: unknown } | null;
  const code = payload?.code;
  if (typeof code !== 'number' || !Number.isInteger(code)) return null;

  return { code, reason: typeof payload?.reason === 'string' ? payload.reason : '' };
}

/** The CORS headers of a response to an allowed cross-origin request. */
export function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': ERROR_HEADER,
    Vary: 'Origin',
  };
}

/** The answer to a CORS preflight from an allowed origin. */
export function preflightAnswer(origin: string): SseAnswer {
  return {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers':
        'Authorization, LiveThing-Secret, LiveThing-Lane, Content-Type',
      'Access-Control-Max-Age': '600',
    },
    body: null,
  };
}
