import { CloseCodes, decodeBase64, LIVETHING_SUBPROTOCOL } from '@livething/core';
import { withScheme } from './transport.ts';
import type { Transport, TransportFactory, TransportOpenOptions } from './transport.ts';

/** The server's limit of frames waiting per connection. */
const MAX_BATCH_FRAMES = 255;
const FRAME_HEADER_BYTES = 5;
/** A POST with no answer in this time counts as failed. */
const POST_TIMEOUT_MS = 30_000;
/** Busy answers with no frame accepted for this long count as a failed POST. */
const BUSY_GIVE_UP_MS = 30_000;
const BUSY_FIRST_WAIT_MS = 250;
const BUSY_MAX_WAIT_MS = 1_000;
/** A connection is stable after this long open, with one POST accepted. */
const STABLE_AFTER_MS = 30_000;
/** How long a close waits for the POST in flight, and then for its own POST. */
const CLOSE_WAIT_MS = 1_000;
/** A close with no close frame, as a WebSocket reports a dropped connection. */
const ABNORMAL_CLOSE = 1006;
/** Statuses that mean the server does not offer this transport, so they are not final. */
const NOT_OFFERED = new Set([404, 405, 426]);
/** Upload only: asks the server for an ack at once. */
const PROBE_FRAME = 2;
/** Upload only: the 4-byte sequence number of the next data frame. */
const START_FRAME = 3;
/** Upload only: the `__close__` frame, after the data frames it must not overtake. */
const CLOSE_FRAME = 4;
/** How long the upload's probe may wait for its ack before the client gives up on it. */
const PROBE_TIMEOUT_MS = 2_000;
/** An upload that wrote nothing for this long sends a probe, so a dead path shows up. */
const IDLE_PROBE_MS = 15_000;
/** After a failed probe, the origin's next connections skip the upload for this long. */
const UPLOAD_RETRY_MS = 10 * 60_000;
/** The upload's frames written and not acked may hold this many times `maxPostBytes`. */
const UPLOAD_WINDOW_POSTS = 4;
/**
 * An upload ends and a fresh one starts after this many new bytes. The fresh one also sends the
 * unacked window again (at most 4 x maxPostBytes), so one upload stays well under Cloudflare's
 * 100 MB body limit at the default maxPostBytes.
 */
const RENEW_UPLOAD_BYTES = 8 * 1024 * 1024;

// Created on first use: a platform without TextEncoder must still load the client.
let encoder: TextEncoder | undefined;
let warnedHttp1 = false;
/** Origins where a probe failed, and when the upload may be tried there again. */
const uploadFailedUntil = new Map<string, number>();

function utf8(text: string): Uint8Array<ArrayBuffer> {
  encoder ??= new TextEncoder();
  return encoder.encode(text);
}

/**
 * Server-sent events from the server, and POST requests from the client. A full transport:
 * use it alone, or list it after `websocket()` to fail over when a network blocks WebSocket.
 * It needs a `fetch` that streams the response body.
 *
 * It starts in batch mode: one POST in flight, with the sends that come meanwhile in the next.
 * Where fetch can stream a request body and the site is not on HTTP/1.1, it also tries stream
 * mode: one long POST that carries every send. A probe frame checks that the server gets the
 * body as it streams. If its ack does not come, the client stays in batch mode.
 */
export function http(): TransportFactory {
  return { name: 'http', open: openHttp };
}

interface QueuedFrame {
  binary: boolean;
  bytes: Uint8Array;
}

function openHttp(options: TransportOpenOptions): Transport {
  if (typeof TextEncoder === 'undefined' || typeof TextDecoder === 'undefined') {
    throw new Error(
      '[livething] http() needs TextEncoder and TextDecoder, and this platform has no global for one of them.',
    );
  }

  const { events } = options;
  const url = withScheme(options.url, 'https', 'http');
  const stream = new AbortController();
  let state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  let silent = false;

  let secret = '';
  let maxPostBytes = 0;

  // Every data frame not yet confirmed, in order. In stream mode the first `written` of them are
  // in the upload, waiting for an ack. `firstSeq` is the sequence number of `dataQueue[0]`.
  const dataQueue: QueuedFrame[] = [];
  let queuedBytes = 0;
  let firstSeq = 1;
  let written = 0;
  let writtenBytes = 0;

  let mode: 'batch' | 'probing' | 'stream' = 'batch';
  let uploadTried = false;
  let probeAcked = false;
  let uploadWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let uploadAbort: AbortController | null = null;
  /** Bytes written to the current upload, for `RENEW_UPLOAD_BYTES`. */
  let uploadBytes = 0;

  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let wroteSinceIdleCheck = false;
  let flushQueued = false;
  let startPending = false;
  /** Runs when the server ends the stream during our close. */
  let onStreamEnded: (() => void) | null = null;
  const controlQueue: string[] = [];
  let dataInFlight: Promise<void> | null = null;
  let controlInFlight: Promise<void> | null = null;

  let busyRoom = MAX_BATCH_FRAMES;
  let busyWait = BUSY_FIRST_WAIT_MS;
  let busySince: number | null = null;
  let busyTimer: ReturnType<typeof setTimeout> | null = null;

  let confirmed = false;
  let openLongEnough = false;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let stableSent = false;

  function isClosed(): boolean {
    return state === 'closed';
  }

  function finish(code: number, reason: string, wasClean: boolean): void {
    if (state === 'closed') return;

    state = 'closed';
    stream.abort();
    endUpload();
    dataQueue.length = 0;
    controlQueue.length = 0;

    queuedBytes = 0;

    if (busyTimer !== null) clearTimeout(busyTimer);

    if (stableTimer !== null) clearTimeout(stableTimer);

    if (!silent) events.close(code, reason, wasClean);
  }

  function fail(reason: string, error?: unknown): void {
    if (state === 'closed') return;

    if (error !== undefined && !silent) events.error(error);

    finish(ABNORMAL_CLOSE, reason, false);
  }

  void readStream();

  async function readStream(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'text/event-stream',
          'LiveThing-Protocol': LIVETHING_SUBPROTOCOL,
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        cache: 'no-store',
        signal: stream.signal,
      });
    } catch (error) {
      fail('stream request failed', error);
      return;
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    if (response.ok && !response.body && contentType.startsWith('text/event-stream')) {
      fail(
        'stream request has no body',
        new Error(
          "[livething] this fetch does not stream a response body, and http() needs one. On React Native, set Expo's expo/fetch as the global fetch.",
        ),
      );
      return;
    }

    if (!response.ok || !response.body || !contentType.startsWith('text/event-stream')) {
      await failForStatus(response);
      return;
    }

    // A close may have run while the request was in flight.
    if (isClosed()) return;

    if (!silent) events.open();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        // Only the new text can hold a new blank line, plus the last character of the old.
        let from = Math.max(0, buffer.length - 1);
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n', from)) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          from = 0;
          handleEvent(block);
          if (state === 'closed') return;
        }
      }
    } catch (error) {
      // An abort is our own close. Anything else, such as Node's body timeout, is a drop.
      if (!stream.signal.aborted && state !== 'closing') fail('stream failed', error);
      onStreamEnded?.();
      return;
    }

    // The server ends the stream when it reads our `__close__`, sometimes before it answers the POST.
    if (state !== 'closing') fail('stream ended without a close');
    onStreamEnded?.();
  }

  /**
   * An answer that opened no stream. An error that LiveThing made, with a 4xx status, is
   * the server's final answer. Anything else may come from a proxy, so it is a drop.
   */
  async function failForStatus(response: Response): Promise<void> {
    const { status } = response;
    const marked = response.headers.has('LiveThing-Error');
    if (!marked || status < 400 || status >= 500 || NOT_OFFERED.has(status)) {
      fail(`stream request answered ${status}`);
      return;
    }

    const reason = (await response.text().catch(() => '')).slice(0, 120);
    let code: number = CloseCodes.AUTH_INVALID;
    if (status === 401) code = CloseCodes.AUTH_EXPIRED;
    else if (status === 429) code = CloseCodes.RATE_LIMITED;

    finish(code, reason, false);
  }

  function handleEvent(block: string): void {
    const text = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
      .join('\n');
    if (text === '') return;

    if (text.startsWith('["__ack__"')) {
      const payload = parsePayload(text) as { seq?: unknown; probe?: unknown } | null;
      if (typeof payload?.seq === 'number') uploadAcked(payload.seq, payload.probe === true);
      return;
    }

    if (text.startsWith('b')) {
      const bytes = decodeBase64(text.slice(1));
      if (bytes) {
        events.message(bytes.buffer);
      } else {
        fail('bad binary event');
      }

      return;
    }

    if (text.startsWith('["__close__"')) {
      const payload = parsePayload(text) as { code?: unknown; reason?: unknown } | null;
      const code = typeof payload?.code === 'number' ? payload.code : CloseCodes.NORMAL;
      finish(code, typeof payload?.reason === 'string' ? payload.reason : '', true);
      return;
    }

    if (state === 'connecting' && text.startsWith('["__connected__"')) {
      const payload = parsePayload(text) as { secret?: unknown; maxPostBytes?: unknown } | null;
      if (typeof payload?.secret !== 'string' || typeof payload.maxPostBytes !== 'number') {
        fail('__connected__ frame has no POST secret');
        return;
      }

      secret = payload.secret;
      maxPostBytes = payload.maxPostBytes;
      state = 'open';
      stableTimer = setTimeout(() => {
        stableTimer = null;
        openLongEnough = true;
        checkStable();
      }, STABLE_AFTER_MS);
    }

    events.message(text);
  }

  function checkStable(): void {
    if (stableSent || !openLongEnough || !confirmed || silent) return;

    stableSent = true;
    events.stable();
  }

  function postAccepted(): void {
    if (state !== 'open') return;

    if (!confirmed) warnIfHttp1(url, options.warn);

    confirmed = true;
    checkStable();
    // The browser reports a request's protocol once it finished, so the try waits for one.
    if (!uploadTried) {
      uploadTried = true;
      if (uploadWorthTrying(url)) startUpload();
    }
  }

  // ---- Stream mode: one long POST ----

  function startUpload(): void {
    mode = 'probing';
    openUploadRequest();
    sendProbe();
  }

  /**
   * Ends a long upload and opens a fresh one, so no one request grows past a proxy's body
   * limit, or past the CPU time one request may use on Cloudflare. The fresh one starts at the
   * first frame without an ack; its start frame takes the lane from the old one, and the server
   * drops the frames it already has.
   */
  function renewUpload(): void {
    const old = uploadWriter;
    void old?.close().catch(() => {});
    openUploadRequest();
    // The frames written again do not count, so each upload carries 8 MiB of new frames, and a
    // window over 8 MiB cannot renew again and again.
    uploadBytes = -writtenBytes;
    written = 0;
    writtenBytes = 0;

    startPending = true;
    scheduleFlush();
  }

  function openUploadRequest(): void {
    uploadBytes = 0;
    const pipe = new TransformStream<Uint8Array, Uint8Array>();
    const writer = pipe.writable.getWriter();
    const abort = new AbortController();
    uploadWriter = writer;

    uploadAbort = abort;
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'LiveThing-Secret': secret,
        'LiveThing-Lane': 'data',
        'LiveThing-Upload': 'stream',
      },
      body: pipe.readable,
      duplex: 'half',
      cache: 'no-store',
      signal: abort.signal,
    } as RequestInit).then(
      // The server answers only when the upload ends, so any answer means it is over.
      (response) => {
        void response.body?.cancel().catch(() => {});
        if (uploadWriter === writer) uploadDied(`upload answered ${response.status}`);
      },
      () => {
        if (uploadWriter === writer) uploadDied('upload request failed');
      },
    );
  }

  function sendProbe(): void {
    writeUpload(encodeFrame(PROBE_FRAME, new Uint8Array(0)));
    probeTimer = setTimeout(() => {
      probeTimer = null;
      uploadDied('no probe ack');
    }, PROBE_TIMEOUT_MS);
  }

  function writeUpload(chunk: Uint8Array): void {
    const writer = uploadWriter;
    wroteSinceIdleCheck = true;
    uploadBytes += chunk.byteLength;
    writer?.write(chunk).catch(() => {
      if (uploadWriter === writer) uploadDied('upload write failed');
    });
  }

  function uploadAcked(seq: number, probe: boolean): void {
    if (probe && probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }

    let acked = 0;
    let ackedBytes = 0;
    while (acked < written && firstSeq + acked <= seq) {
      ackedBytes += dataQueue[acked]!.bytes.byteLength;
      acked++;
    }

    if (acked > 0) {
      dataQueue.splice(0, acked);
      firstSeq += acked;
      written -= acked;
      writtenBytes -= ackedBytes + acked * FRAME_HEADER_BYTES;
      queuedBytes -= ackedBytes;
    }

    if (mode === 'probing' && probe) {
      probeAcked = true;
      moveToStream();
    } else if (mode === 'stream') {
      scheduleFlush();
    }
  }

  /** After the probe ack, once no data POST is in flight, every send goes in the upload. */
  function moveToStream(): void {
    if (!probeAcked || mode !== 'probing' || dataInFlight || busyTimer !== null) return;

    if (state !== 'open') return;

    mode = 'stream';
    startPending = true;
    wroteSinceIdleCheck = false;
    idleTimer = setTimeout(checkIdle, IDLE_PROBE_MS);
    scheduleFlush();
  }

  function checkIdle(): void {
    idleTimer = null;
    if (mode !== 'stream') return;

    if (!wroteSinceIdleCheck && probeTimer === null) sendProbe();

    wroteSinceIdleCheck = false;
    idleTimer = setTimeout(checkIdle, IDLE_PROBE_MS);
  }

  function scheduleFlush(): void {
    if (flushQueued) return;

    flushQueued = true;
    queueMicrotask(flushUpload);
  }

  /** Writes the frames that fit in the window, all in one chunk. */
  function flushUpload(): void {
    flushQueued = false;
    if (mode !== 'stream') return;

    const window = UPLOAD_WINDOW_POSTS * maxPostBytes;
    let count = written;
    let bytes = writtenBytes;
    while (count < dataQueue.length) {
      const next = dataQueue[count]!.bytes.byteLength + FRAME_HEADER_BYTES;
      // One frame always goes when none is waiting for an ack, so a big one cannot stall.
      if (bytes + next > window && count > 0) break;

      bytes += next;
      count++;
    }

    if (count === written && !startPending) return;

    let start: Uint8Array | null = null;
    if (startPending) {
      startPending = false;
      const seq = new Uint8Array(4);
      new DataView(seq.buffer).setUint32(0, firstSeq + written, false);
      start = encodeFrame(START_FRAME, seq);
    }

    const frames = encodeBatch(dataQueue.slice(written, count), start);
    written = count;
    writtenBytes = bytes;
    writeUpload(frames);
    // While it closes, the frames stay in this upload until their ack.
    if (state === 'open' && uploadBytes >= RENEW_UPLOAD_BYTES) renewUpload();
  }

  /**
   * The upload stopped. Its frames that were not acked go again in batch mode, and the
   * server drops the ones it already has. A probe that failed is remembered for the origin.
   */
  function uploadDied(reason: string, probeFailed = !probeAcked): void {
    if (mode === 'batch') return;

    if (probeFailed) uploadFailedUntil.set(originOf(url), Date.now() + UPLOAD_RETRY_MS);

    if (!silent && state === 'open') options.warn(`http() stays in batch mode: ${reason}.`);

    endUpload();
    if (state === 'open') pumpData();
  }

  /** Stops the upload and its timers. The frames it held wait for the next POST of batch mode. */
  function endUpload(): void {
    mode = 'batch';
    probeAcked = false;
    startPending = false;
    if (probeTimer !== null) clearTimeout(probeTimer);

    if (idleTimer !== null) clearTimeout(idleTimer);

    probeTimer = null;
    idleTimer = null;
    written = 0;
    writtenBytes = 0;
    uploadAbort?.abort();

    uploadAbort = null;
    uploadWriter = null;
  }

  async function post(
    lane: 'data' | 'control',
    body: Uint8Array<ArrayBuffer>,
    seq?: number,
  ): Promise<Response> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), POST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'LiveThing-Secret': secret,
          'LiveThing-Lane': lane,
          ...(seq === undefined ? {} : { 'LiveThing-Seq': String(seq) }),
        },
        body,
        cache: 'no-store',
        signal: timeout.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** A POST that failed after the open. A 404 means the server forgot the connection. */
  function postFailed(response: Response | null, error?: unknown): void {
    if (state !== 'open') return;

    if (response?.status === 403 && response.headers.has('LiveThing-Error')) {
      finish(CloseCodes.AUTH_INVALID, 'Origin not allowed', false);
      return;
    }

    // A 404 means the server forgot this connection, which says nothing about the path.
    if (!confirmed && response?.status !== 404 && !silent) events.unusable();

    fail(response ? `POST answered ${response.status}` : 'POST failed', error);
  }

  function pumpData(): void {
    if (mode === 'stream') {
      scheduleFlush();
      return;
    }

    if (dataInFlight || busyTimer !== null || state !== 'open' || dataQueue.length === 0) return;

    let count = 0;
    let size = 0;
    const limit = Math.min(busyRoom, MAX_BATCH_FRAMES);

    while (count < dataQueue.length && count < limit) {
      const next = dataQueue[count]!.bytes.byteLength + FRAME_HEADER_BYTES;
      if (size + next > maxPostBytes) break;

      size += next;
      count++;
    }

    const batch = dataQueue.slice(0, count);

    dataInFlight = sendData(batch, firstSeq).finally(() => {
      dataInFlight = null;
      moveToStream();
      pumpData();
    });
  }

  async function sendData(batch: QueuedFrame[], seq: number): Promise<void> {
    let response: Response;
    try {
      response = await post('data', encodeBatch(batch), seq);
    } catch (error) {
      postFailed(null, error);
      return;
    }

    if (state !== 'open') return;

    if (response.status === 204) {
      dataQueue.splice(0, batch.length);
      firstSeq += batch.length;

      for (const frame of batch) queuedBytes -= frame.bytes.byteLength;

      busyRoom = MAX_BATCH_FRAMES;
      busyWait = BUSY_FIRST_WAIT_MS;
      busySince = null;

      postAccepted();

      return;
    }

    if (response.status === 503 && response.headers.get('LiveThing-Error') === 'busy') {
      const answer = (await response.json().catch(() => null)) as {
        room?: unknown;
        retryAfterMs?: unknown;
      } | null;

      busySince ??= Date.now();

      if (Date.now() - busySince > BUSY_GIVE_UP_MS) {
        postFailed(response);
        return;
      }

      // Send only what fits next time, so the server need not refuse the batch again.
      busyRoom = typeof answer?.room === 'number' && answer.room > 0 ? answer.room : 1;
      const retryAfterMs = typeof answer?.retryAfterMs === 'number' ? answer.retryAfterMs : 0;
      const wait = Math.max(busyWait, retryAfterMs);

      busyWait = Math.min(busyWait * 2, BUSY_MAX_WAIT_MS);

      busyTimer = setTimeout(() => {
        busyTimer = null;
        moveToStream();
        pumpData();
      }, wait);

      return;
    }

    postFailed(response);
  }

  function pumpControl(): void {
    if (controlInFlight || state !== 'open' || controlQueue.length === 0) return;

    const frames = controlQueue.splice(0);

    controlInFlight = sendControlBatch(frames).finally(() => {
      controlInFlight = null;
      pumpControl();
    });
  }

  async function sendControlBatch(frames: string[]): Promise<void> {
    const batch = frames.map((frame) => ({ binary: false, bytes: utf8(frame) }));
    let response: Response;
    try {
      response = await post('control', encodeBatch(batch));
    } catch (error) {
      postFailed(null, error);
      return;
    }

    if (response.status === 204) {
      postAccepted();
    } else {
      postFailed(response);
    }
  }

  /**
   * Close in order, so the close does not overtake earlier messages. In stream mode the
   * `__close__` frame goes in the upload after them, and the server ends the stream once it
   * reads it. In batch mode, the data POST in flight lands first, then `__close__` goes on the
   * control lane. Each wait is at most one second. Messages still queued are dropped.
   */
  async function closeInOrder(code: number, reason: string): Promise<void> {
    if (state === 'closing' || state === 'closed') return;

    if (state === 'connecting') {
      finish(code, reason, false);
      return;
    }

    state = 'closing';
    // A send of this tick waits for a microtask to reach the upload. Write it now, as batch mode
    // would have put it in its POST already. The frames in the upload stay until their ack; the
    // ones past the window are dropped.
    if (flushQueued) flushUpload();
    for (const frame of dataQueue.splice(written)) queuedBytes -= frame.bytes.byteLength;

    controlQueue.length = 0;
    const frame = utf8(JSON.stringify(['__close__', { code, reason }, null]));

    const writer = uploadWriter;
    if (mode === 'stream' && writer) {
      const ended = new Promise<void>((resolve) => (onStreamEnded = resolve));
      writeUpload(encodeFrame(CLOSE_FRAME, frame));
      void writer.close().catch(() => {});
      // The upload's answer now only means the server read the close: it is no failure.
      uploadWriter = null;
      if (await settleWithin(ended)) {
        finish(code, reason, true);
        return;
      }
    }

    await settleWithin(dataInFlight);
    endUpload();
    dataQueue.length = 0;
    queuedBytes = 0;

    // A second control POST while one is still open gets a 409, which closes with 1002.
    if (await settleWithin(controlInFlight)) {
      await settleWithin(post('control', encodeBatch([{ binary: false, bytes: frame }])));
    }

    finish(code, reason, true);
  }

  return {
    name: 'http',
    protocol: '',
    webSocket: null,
    reportsStable: true,

    isOpen: () => state === 'open',

    send(data) {
      if (state !== 'open') return;

      const bytes = typeof data === 'string' ? utf8(data) : data;
      if (bytes.byteLength + FRAME_HEADER_BYTES > maxPostBytes) {
        throw new RangeError(
          `[livething] the message is ${bytes.byteLength} bytes, over the server's POST limit of ${maxPostBytes - FRAME_HEADER_BYTES} bytes on server-sent events. Send large data with uploads().`,
        );
      }

      dataQueue.push({ binary: typeof data !== 'string', bytes });
      queuedBytes += bytes.byteLength;

      pumpData();
    },

    sendControl(frame) {
      controlQueue.push(frame);
      pumpControl();
    },

    bufferedAmount: () => queuedBytes,

    close(code = CloseCodes.NORMAL, reason = '') {
      void closeInOrder(code, reason);
    },

    dispose(code = CloseCodes.NORMAL, reason = '') {
      silent = true;
      void closeInOrder(code, reason);
    },
  };
}

/** Frames as one POST body: 1 byte for the type (0 text, 1 binary), 4 for the length, the data. */
function encodeBatch(
  frames: readonly QueuedFrame[],
  prefix: Uint8Array | null = null,
): Uint8Array<ArrayBuffer> {
  const start = prefix?.byteLength ?? 0;
  const size = frames.reduce(
    (sum, frame) => sum + FRAME_HEADER_BYTES + frame.bytes.byteLength,
    start,
  );
  const body = new Uint8Array(size);
  const view = new DataView(body.buffer);
  if (prefix) body.set(prefix);

  let offset = start;
  for (const frame of frames) {
    body[offset] = frame.binary ? 1 : 0;
    view.setUint32(offset + 1, frame.bytes.byteLength, false);
    body.set(frame.bytes, offset + FRAME_HEADER_BYTES);
    offset += FRAME_HEADER_BYTES + frame.bytes.byteLength;
  }

  return body;
}

/** One upload frame of the given type. */
function encodeFrame(type: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + data.byteLength);
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, data.byteLength, false);
  frame.set(data, FRAME_HEADER_BYTES);

  return frame;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Whether to try stream mode: fetch can stream a request body, the origin's last probe did
 * not fail lately, and the site is not on HTTP/1.1, where Chrome refuses a streaming body and
 * the upload would hold one of the six connections.
 */
function uploadWorthTrying(url: string): boolean {
  const until = uploadFailedUntil.get(originOf(url));
  if (until !== undefined && until > Date.now()) return false;

  if (!canStreamUploads()) return false;

  const entries =
    typeof performance === 'undefined'
      ? undefined
      : (performance.getEntriesByName?.(url) as PerformanceResourceTiming[] | undefined);

  return !entries?.some((entry) => entry.nextHopProtocol === 'http/1.1');
}

/**
 * Where fetch streams a request body, `new Request` reads `duplex` and sets no Content-Type
 * for a stream body. Firefox and Safari do neither.
 */
function canStreamUploads(): boolean {
  if (typeof ReadableStream === 'undefined' || typeof TransformStream === 'undefined') return false;

  try {
    let duplexRead = false;
    const request = new Request('https://livething.invalid/', {
      method: 'POST',
      body: new ReadableStream(),
      get duplex() {
        duplexRead = true;
        return 'half';
      },
    } as RequestInit);
    return duplexRead && !request.headers.has('Content-Type');
  } catch {
    return false;
  }
}

function parsePayload(text: string): unknown {
  try {
    return (JSON.parse(text) as unknown[])[1] ?? null;
  } catch {
    return null;
  }
}

/** Waits up to `CLOSE_WAIT_MS` for the promise, and says whether it settled in that time. */
async function settleWithin(promise: Promise<unknown> | null): Promise<boolean> {
  if (!promise) return true;

  let timer: ReturnType<typeof setTimeout> | undefined;

  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), CLOSE_WAIT_MS);
    }),
  ]);

  clearTimeout(timer);

  return settled;
}

/**
 * HTTP/1.1 allows six connections per site, shared by every tab, and each SSE connection
 * holds up to three. The browser reports the protocol of a finished request, so the
 * check runs after the first POST.
 */
function warnIfHttp1(url: string, warn: (message: string) => void): void {
  if (warnedHttp1 || typeof performance === 'undefined') return;

  const entries = performance.getEntriesByName?.(url) as PerformanceResourceTiming[] | undefined;
  if (!entries?.some((entry) => entry.nextHopProtocol === 'http/1.1')) return;

  warnedHttp1 = true;
  warn(
    'http() is running over HTTP/1.1, which allows six connections per site across all tabs. Serve the site over HTTP/2 or HTTP/3.',
  );
}
