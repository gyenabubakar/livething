import { CloseCodes, encodeBase64, LIVETHING_SUBPROTOCOL, splitBinaryFrame } from '@livething/core';
import { isProtocolEventName } from '~/_engine/runtime/protocol.ts';
import { normalizeCloseReason } from './close.ts';
import type { ConnectionHandle, SocketDescriptor, TransportFrame } from './types.ts';

/** The headers of a server-sent events response. `no-transform` stops a proxy compressing it. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no',
};

/** The header that marks an error response as LiveThing's own, not a proxy's. */
export const ERROR_HEADER = 'LiveThing-Error';

/**
 * The header the client sends on its stream `GET`. It is not CORS-safelisted, so a page on
 * another origin must send a preflight first, and a preflight always carries `Origin`.
 * Without it, a cross-site `fetch(url, { mode: 'no-cors' })` opens a stream with the user's
 * cookies and no `Origin` header, which the Origin check lets through.
 */
export const PROTOCOL_HEADER = 'LiveThing-Protocol';

/** Whether a `GET` asks for a LiveThing event stream, from its `Accept` and protocol headers. */
export function isStreamRequest(accept: string | null, protocol: string | null): boolean {
  return (accept ?? '').includes('text/event-stream') && protocol === LIVETHING_SUBPROTOCOL;
}

/** One answer to an HTTP request of the http transport. */
export interface HttpAnswer {
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
/** Upload only: asks for an ack at once. The client sends one first, and on an idle upload. */
const PROBE_FRAME = 2;
/** Upload only: the 4-byte sequence number of the next data frame. Data frames follow it. */
const START_FRAME = 3;
const FRAME_HEADER_BYTES = 5;

/**
 * The header of a data POST: the sequence number of its first frame. The client numbers every
 * data frame of a connection from 1, across POSTs and the upload, so the server can drop a
 * frame it already has when the client sends it again.
 */
export const SEQ_HEADER = 'LiveThing-Seq';

/** `LiveThing-Upload: stream` marks the one long POST whose body streams frames. */
export const UPLOAD_HEADER = 'LiveThing-Upload';

/** How long the acks of an upload wait, so a burst of frames gets one ack. */
const ACK_DELAY_MS = 20;

/** An upload that sends nothing, not even a probe, for this long is stopped. */
const UPLOAD_IDLE_MS = 45_000;

/** A close with no close frame, as a WebSocket reports a dropped connection. */
const ABNORMAL_CLOSE = 1006;

const encoder = new TextEncoder();
const sharedEvents = new WeakMap<TransportFrame, Uint8Array>();

/** One `data:` event for a frame. A binary frame is `b` and the whole frame in base64. */
function sseEvent(frame: TransportFrame): Uint8Array {
  return encoder.encode(
    frame.kind === 'text' ? `data: ${frame.text}\n\n` : `data: b${encodeBase64(frame.bytes)}\n\n`,
  );
}

/** A broadcast hands every stream the same frame, so its event is built once for all of them. */
function sseEventOnce(frame: TransportFrame): Uint8Array {
  if (!frame.shared) return sseEvent(frame);

  let event = sharedEvents.get(frame);
  if (event === undefined) {
    event = sseEvent(frame);
    sharedEvents.set(frame, event);
  }

  return event;
}

/**
 * The last event of a stream: the close code and reason, because SSE has no close frame.
 * The reason keeps the WebSocket limit, so it reads the same over both transports.
 */
export function sseCloseEvent(code: number, reason: string): string {
  return `data: ${JSON.stringify(['__close__', { code, reason: normalizeCloseReason(reason) }, null])}\n\n`;
}

/** An error answer that the client can tell apart from a proxy's. */
export function errorAnswer(status: number, error: string, body: string | null = null): HttpAnswer {
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
  /** The chunk can be shared by many streams, so the sink must not change or transfer it. */
  write(chunk: Uint8Array): void;
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
  /** The sequence number of the last data frame handed to the engine. */
  lastSeq: number;
  /** The upload that holds the data lane, from its start frame on. */
  laneUpload: UploadControl | null;
  /** Every open upload of the connection, started or not. */
  uploads: Set<UploadControl>;
  /** An upload waiting for room. Runs once a frame in flight finishes. */
  roomWaiter: (() => void) | null;
  /** Writes one event on the stream, if it is still open. */
  event(text: string): void;
  close(code: number, reason: string): void;
  closeFromClient(code: number, reason: string): void;
}

interface UploadControl {
  stop(answer: HttpAnswer): void;
}

/** A POST whose headers passed. The adapter reads the body, then calls `finish` or `cancel`. */
export interface HttpPost {
  finish(body: Uint8Array): HttpAnswer;
  /** The body could not be read: clear the lane so the next POST is not refused. */
  cancel(): void;
}

/**
 * The one long POST of a connection. The adapter hands over each chunk of the body as it
 * arrives, and reads the next chunk only after the promise `push` returns, so a connection
 * with no room slows its client through the network's own flow control.
 */
export interface HttpUpload {
  /**
   * Hand over one chunk of the body. A promise means: wait for it before reading more. The hub
   * owns the chunk from here: binary frames go to the engine as views of it, so the adapter must
   * not reuse or change its buffer.
   */
  push(chunk: Uint8Array): Promise<void> | null;
  /** The body ended. Sends the last ack and returns the answer. */
  finish(): HttpAnswer;
  /** The body broke off. */
  cancel(): void;
  /**
   * Resolves when the hub stops the upload itself: a POST took the data lane, a frame broke
   * the rules, it went idle, or the connection closed. The adapter stops reading and answers
   * with it.
   */
  readonly stopped: Promise<HttpAnswer>;
}

interface Frame {
  type: number;
  data: Uint8Array;
  text?: string;
  /** Whether the frame waits in line, so it counts against the connection's room. */
  counted: boolean;
}

/** The secret-to-connection map and the POST rules shared by every adapter. */
export interface HttpHub {
  readonly maxPostBytes: number;
  openStream(sink: SseSink): SseStream;
  /**
   * Check a POST's secret, lane and, on the data lane, the sequence number of its first frame,
   * before its body is read.
   */
  beginPost(secret: string | null, lane: string | null, seq?: string | null): HttpPost | HttpAnswer;
  /** Check the upload's secret before its body is read. */
  beginUpload(secret: string | null): HttpUpload | HttpAnswer;
}

export interface HttpHubOptions {
  maxPostBytes: number;
  /** The engine's receive limit. Frames in flight may hold this many bytes, half its budget. */
  receiveBytes: number;
}

/** The http transport module of one endpoint. */
export function createHttpHub(options: HttpHubOptions): HttpHub {
  const { maxPostBytes, receiveBytes } = options;
  const sessions = new Map<string, Session>();

  function openStream(sink: SseSink): SseStream {
    const secret = createSecret();
    let handle: ConnectionHandle | null = null;
    let session: Session | null = null;
    let closed = false;

    function finish(code: number, reason: string): void {
      closed = true;
      sessions.delete(secret);
      if (session) {
        for (const upload of session.uploads) upload.stop(errorAnswer(410, 'closed'));
      }

      // The engine is the caller of `close`, so it hears about the close a moment later.
      const current = handle;
      if (current) queueMicrotask(() => void current.handleClose(code, reason));
    }

    function close(code: number = CloseCodes.NORMAL, reason = ''): void {
      if (closed) return;

      sink.write(encoder.encode(sseCloseEvent(code, reason)));
      sink.end();
      finish(code, reason);
    }

    return {
      socket: {
        // `false` only for a closed stream: a full buffer still delivers, and replay counts it.
        send(frame) {
          if (closed) return false;

          sink.write(sseEventOnce(frame));
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

        session = {
          handle: connection,
          lanes: { data: false, control: false },
          inFlightFrames: 0,
          inFlightBytes: 0,
          lastSeq: 0,
          laneUpload: null,
          uploads: new Set(),
          roomWaiter: null,
          event(text) {
            if (!closed) sink.write(encoder.encode(`data: ${text}\n\n`));
          },
          close,
          closeFromClient(code, reason) {
            if (closed) return;

            sink.end();
            finish(code, reason);
          },
        };
        sessions.set(secret, session);
      },
      ended() {
        if (!closed) finish(ABNORMAL_CLOSE, 'stream ended');
      },
    };
  }

  function beginPost(
    secret: string | null,
    laneName: string | null,
    seqHeader: string | null = null,
  ): HttpPost | HttpAnswer {
    const found = secret === null ? undefined : sessions.get(secret);
    if (!found) return errorAnswer(404, 'unknown-connection');

    const session = found;

    if (laneName !== 'data' && laneName !== 'control') {
      session.close(CloseCodes.PROTOCOL_ERROR, 'bad LiveThing-Lane header');
      return errorAnswer(400, 'bad-lane');
    }

    const lane = laneName;
    const firstSeq = lane === 'data' ? readSeq(seqHeader) : 0;
    if (firstSeq === null) {
      session.close(CloseCodes.PROTOCOL_ERROR, 'bad LiveThing-Seq header');
      return errorAnswer(400, 'bad-seq');
    }

    // The client sends a data POST only once it stopped using its upload, so the POST takes
    // the lane. The upload's frames that were not handed over come again in this POST.
    if (lane === 'data') session.laneUpload?.stop(errorAnswer(409, 'lane-taken'));

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
          lane === 'control' ? deliverControl(session, body) : deliverData(session, body, firstSeq);
        clearLane();
        return answer;
      },
    };
  }

  function deliverControl(session: Session, body: Uint8Array): HttpAnswer {
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

  function deliverData(session: Session, body: Uint8Array, firstSeq: number): HttpAnswer {
    const frames = parseBatch(body);
    if (!frames) {
      session.close(CloseCodes.PROTOCOL_ERROR, 'bad POST batch');
      return errorAnswer(400, 'bad-batch');
    }

    if (firstSeq > session.lastSeq + 1) {
      session.close(CloseCodes.PROTOCOL_ERROR, 'data frames are missing');
      return errorAnswer(400, 'bad-seq');
    }

    // The leading frames the engine already has, from the upload, are dropped.
    const known = Math.min(frames.length, session.lastSeq - firstSeq + 1);
    const room = known + roomFor(session, frames, known);
    if (room < frames.length) {
      return {
        status: 503,
        headers: { [ERROR_HEADER]: 'busy', 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, retryAfterMs: BUSY_RETRY_AFTER_MS }),
      };
    }

    for (let index = known; index < frames.length; index++) handOver(session, frames[index]!);

    session.lastSeq = Math.max(session.lastSeq, firstSeq + frames.length - 1);

    return NO_CONTENT;
  }

  /** How many frames of a batch, from `from` on, fit beside the frames already in flight. */
  function roomFor(session: Session, frames: readonly Frame[], from: number): number {
    let count = session.inFlightFrames;
    let bytes = session.inFlightBytes;
    for (let index = from; index < frames.length; index++) {
      const frame = frames[index]!;
      if (!frame.counted) continue;

      count++;
      bytes += frame.data.byteLength;
      if (count > MAX_IN_FLIGHT_FRAMES || bytes > receiveBytes) return index - from;
    }

    return frames.length - from;
  }

  function hasRoom(session: Session, frame: Frame): boolean {
    return (
      !frame.counted ||
      (session.inFlightFrames < MAX_IN_FLIGHT_FRAMES &&
        session.inFlightBytes + frame.data.byteLength <= receiveBytes)
    );
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
        const wake = session.roomWaiter;
        if (wake) {
          session.roomWaiter = null;
          wake();
        }
      });
  }

  function beginUpload(secret: string | null): HttpUpload | HttpAnswer {
    const found = secret === null ? undefined : sessions.get(secret);
    if (!found) return errorAnswer(404, 'unknown-connection');

    return new Upload(found);
  }

  /**
   * The state of one upload. A class, not closures: a connection holds its upload for its whole
   * life, and one object costs much less memory than a closure for each function.
   */
  class Upload implements HttpUpload, UploadControl {
    readonly stopped: Promise<HttpAnswer>;
    private readonly session: Session;
    private isStopped = false;
    private started = false;
    /** The sequence number of the last data frame read from this body. */
    private seq = 0;
    private ackedSeq: number;
    private ackTimer: ReturnType<typeof setTimeout> | null = null;
    /** The chunks of a frame that is not whole yet. They are joined once `carryNeeds` bytes are in. */
    private carry: Uint8Array[] = [];
    private carryBytes = 0;
    private carryNeeds = 0;
    private lastActivity = Date.now();
    private idleTimer: ReturnType<typeof setTimeout> | null;
    /** Wakes the adapter's read loop when this upload waits for room. */
    private waiting: (() => void) | null = null;
    private stoppedWith!: (answer: HttpAnswer) => void;

    constructor(session: Session) {
      this.session = session;
      this.ackedSeq = session.lastSeq;
      this.idleTimer = setTimeout(checkIdle, UPLOAD_IDLE_MS, this);
      this.stopped = new Promise<HttpAnswer>((resolve) => (this.stoppedWith = resolve));
      session.uploads.add(this);
    }

    /** The body broke off. */
    cancel(): void {
      this.release();
    }

    private release(): void {
      this.isStopped = true;
      if (this.idleTimer !== null) clearTimeout(this.idleTimer);
      if (this.ackTimer !== null) clearTimeout(this.ackTimer);
      this.idleTimer = null;
      this.ackTimer = null;

      this.carry = [];
      this.carryBytes = 0;
      const { session } = this;
      session.uploads.delete(this);
      if (session.laneUpload === this) {
        session.laneUpload = null;
        session.lanes.data = false;
      }

      const { waiting } = this;
      if (waiting) {
        if (session.roomWaiter === waiting) session.roomWaiter = null;
        waiting();
      }
    }

    stop(answer: HttpAnswer): void {
      if (this.isStopped) return;

      this.release();
      this.stoppedWith(answer);
    }

    private breakRules(reason: string): void {
      this.stop(errorAnswer(400, 'bad-upload'));
      this.session.close(CloseCodes.PROTOCOL_ERROR, reason);
    }

    // The timer is not moved on each chunk: it checks the time of the last one when it fires.
    checkIdle(): void {
      this.idleTimer = null;
      if (this.isStopped) return;

      // A wait for room is the server's doing, not the client's.
      const idle = this.waiting ? 0 : Date.now() - this.lastActivity;
      if (idle >= UPLOAD_IDLE_MS) {
        this.stop(errorAnswer(408, 'idle'));
        return;
      }

      this.idleTimer = setTimeout(checkIdle, UPLOAD_IDLE_MS - idle, this);
    }

    private ack(probe: boolean): void {
      const seq = (this.ackedSeq = this.session.lastSeq);
      this.session.event(
        probe ? `["__ack__",{"seq":${seq},"probe":true},null]` : `["__ack__",{"seq":${seq}},null]`,
      );
    }

    flushAck(): void {
      this.ackTimer = null;
      if (!this.isStopped && this.session.lastSeq > this.ackedSeq) this.ack(false);
    }

    private takeLane(first: number): boolean {
      const { session } = this;
      if (first < 1 || first > session.lastSeq + 1) {
        this.breakRules('data frames are missing');
        return false;
      }

      if (session.laneUpload !== this) {
        session.laneUpload?.stop(errorAnswer(409, 'lane-taken'));
        if (session.lanes.data) {
          this.breakRules('an upload and a POST at once in the data lane');
          return false;
        }

        session.lanes.data = true;
        session.laneUpload = this;
      }

      this.started = true;
      this.seq = first - 1;
      // The client starts again from its first frame without an ack, so the frames the server
      // already has need an ack too: the old upload's waiting ack went when it lost the lane.
      this.ackedSeq = Math.min(this.ackedSeq, this.seq);
      if (session.lastSeq > this.ackedSeq) {
        this.ackTimer ??= setTimeout(flushAck, ACK_DELAY_MS, this);
      }

      return true;
    }

    /** Reads the frames of `data` from `offset`. A promise when it waits for room. */
    private consume(data: Uint8Array, offset: number): Promise<void> | null {
      const { session } = this;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      while (!this.isStopped && data.byteLength - offset >= FRAME_HEADER_BYTES) {
        const type = data[offset]!;
        const length = view.getUint32(offset + 1, false);
        if (length > maxPostBytes - FRAME_HEADER_BYTES) {
          this.stop(errorAnswer(413, 'too-large'));
          return null;
        }

        const end = offset + FRAME_HEADER_BYTES + length;
        if (end > data.byteLength) break;

        if (type === PROBE_FRAME) {
          this.ack(true);
        } else if (type === START_FRAME) {
          if (length !== 4) {
            this.breakRules('bad upload start frame');
            return null;
          }

          if (!this.takeLane(view.getUint32(offset + FRAME_HEADER_BYTES, false))) return null;
        } else {
          if (!this.started) {
            this.breakRules('upload data before its start frame');
            return null;
          }

          const frameSeq = this.seq + 1;
          if (frameSeq > session.lastSeq) {
            const frame = parseFrame(type, data.subarray(offset + FRAME_HEADER_BYTES, end));
            if (!frame) {
              this.breakRules('bad upload frame');
              return null;
            }

            if (!hasRoom(session, frame)) return this.waitForRoom(data, offset);

            handOver(session, frame);
            session.lastSeq = frameSeq;
            this.ackTimer ??= setTimeout(flushAck, ACK_DELAY_MS, this);
          }

          this.seq = frameSeq;
        }

        offset = end;
      }

      if (!this.isStopped && offset < data.byteLength) {
        // A copy, also for a Node Buffer, whose `slice` is a view.
        const rest = new Uint8Array(data.subarray(offset));
        this.carry = [rest];
        this.carryBytes = rest.byteLength;
        this.carryNeeds =
          rest.byteLength < FRAME_HEADER_BYTES
            ? FRAME_HEADER_BYTES
            : FRAME_HEADER_BYTES + view.getUint32(offset + 1, false);
      }

      return null;
    }

    private waitForRoom(data: Uint8Array, offset: number): Promise<void> {
      return new Promise<void>((resolve) => {
        this.waiting = resolve;
        this.session.roomWaiter = resolve;
      }).then(() => {
        this.waiting = null;
        this.lastActivity = Date.now();
        return this.isStopped ? undefined : (this.consume(data, offset) ?? undefined);
      });
    }

    push(chunk: Uint8Array): Promise<void> | null {
      if (this.isStopped) return null;

      this.lastActivity = Date.now();
      if (this.carry.length === 0) return this.consume(chunk, 0);

      // A copy: an adapter may reuse its chunk buffer after `push` returns.
      this.carry.push(new Uint8Array(chunk));
      this.carryBytes += chunk.byteLength;
      if (this.carryBytes < this.carryNeeds) return null;

      const data = new Uint8Array(this.carryBytes);
      let at = 0;
      for (const part of this.carry) {
        data.set(part, at);
        at += part.byteLength;
      }

      this.carry = [];
      this.carryBytes = 0;

      return this.consume(data, 0);
    }

    finish(): HttpAnswer {
      if (this.isStopped) return errorAnswer(410, 'closed');

      const broken = this.carry.length > 0;
      if (this.session.lastSeq > this.ackedSeq) this.ack(false);
      this.release();

      return broken ? errorAnswer(400, 'aborted') : NO_CONTENT;
    }
  }

  function checkIdle(upload: Upload): void {
    upload.checkIdle();
  }

  function flushAck(upload: Upload): void {
    upload.flushAck();
  }

  return { maxPostBytes, openStream, beginPost, beginUpload };
}

/** The `LiveThing-Seq` header as a sequence number from 1, or `null` when it is not one. */
function readSeq(header: string | null): number | null {
  if (header === null) return null;

  const seq = Number(header);
  return Number.isSafeInteger(seq) && seq >= 1 && String(seq) === header ? seq : null;
}

const NO_CONTENT: HttpAnswer = { status: 204, headers: {}, body: null };

const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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

    const frame = parseFrame(type, body.subarray(start, start + length));
    if (!frame) return null;

    frames.push(frame);
    offset = start + length;
  }

  return frames;
}

/** One text or binary frame, or `null` for another type or text that is not UTF-8. */
function parseFrame(type: number, data: Uint8Array): Frame | null {
  if (type === TEXT_FRAME) {
    let text: string;
    try {
      text = textDecoder.decode(data);
    } catch {
      return null;
    }

    return { type, data, text, counted: waitsInLine(parseJson(text), false) };
  }

  if (type !== BINARY_FRAME) return null;

  const split = splitBinaryFrame(data);
  const envelope = split.kind === 'frame' ? parseJson(split.envelope) : undefined;

  return { type, data, counted: waitsInLine(envelope, true) };
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

/**
 * The code and reason of a client's `__close__` frame, or `null` for any other text. Like a
 * WebSocket client's close frame, the code is `1000` or `3000`-`4999`, and the reason keeps
 * the 123-byte limit.
 */
function readClose(text: string | undefined): { code: number; reason: string } | null {
  if (text === undefined || !text.startsWith('["__close__"')) return null;

  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) return null;

  const payload = parsed[1] as { code?: unknown; reason?: unknown } | null;
  const code = payload?.code;
  if (typeof code !== 'number' || !Number.isInteger(code)) return null;

  if (code !== CloseCodes.NORMAL && (code < 3000 || code > 4999)) return null;

  const reason = typeof payload?.reason === 'string' ? payload.reason : '';

  return { code, reason: normalizeCloseReason(reason)! };
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
export function preflightAnswer(origin: string): HttpAnswer {
  return {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers':
        'Authorization, LiveThing-Protocol, LiveThing-Secret, LiveThing-Lane, LiveThing-Seq, LiveThing-Upload, Content-Type',
      'Access-Control-Max-Age': '600',
    },
    body: null,
  };
}
