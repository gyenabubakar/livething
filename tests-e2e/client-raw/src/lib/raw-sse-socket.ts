// A raw client for the SSE run of this lane. It has the shape of the browser's WebSocket,
// so the same specs talk to the server over SSE: the frames go down a real event stream
// and up as real POSTs, and the specs see exactly what the server sent, `__connected__`,
// `ping` and `__close__` included, as they do over WebSocket.

const TEXT_FRAME = 0;
const BINARY_FRAME = 1;
const MAX_BATCH_FRAMES = 255;

type Data = string | ArrayBufferLike | Blob | ArrayBufferView;

interface Queued {
  type: number;
  bytes: Uint8Array;
}

function encodeBatch(frames: readonly Queued[]): Uint8Array<ArrayBuffer> {
  const size = frames.reduce((total, frame) => total + 5 + frame.bytes.byteLength, 0);
  const body = new Uint8Array(size);
  const view = new DataView(body.buffer);
  let offset = 0;
  for (const frame of frames) {
    body[offset] = frame.type;
    view.setUint32(offset + 1, frame.bytes.byteLength);
    body.set(frame.bytes, offset + 5);
    offset += 5 + frame.bytes.byteLength;
  }

  return body;
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export class RawSseSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  readyState = RawSseSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private readonly httpUrl: string;
  private readonly stream = new AbortController();
  private secret: string | null = null;
  /** The code and reason this side closed with: the server ends the stream after it. */
  private closing: { code: number; reason: string } | null = null;
  private readonly lanes = {
    data: { queue: [] as Queued[], busy: false },
    control: { queue: [] as Queued[], busy: false },
  };

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    this.httpUrl = this.url.replace(/^ws/, 'http');
    void this.read();
  }

  get bufferedAmount(): number {
    return [...this.lanes.data.queue, ...this.lanes.control.queue].reduce(
      (total, frame) => total + frame.bytes.byteLength,
      0,
    );
  }

  send(data: Data): void {
    if (this.readyState === RawSseSocket.CONNECTING) {
      throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
    }

    if (this.readyState !== RawSseSocket.OPEN) return;

    if (typeof data === 'string') {
      // `ping` and `pong` go on the control lane, as the client library sends them.
      const lane = data === 'ping' || data === 'pong' ? 'control' : 'data';
      this.enqueue(lane, { type: TEXT_FRAME, bytes: new TextEncoder().encode(data) });
      return;
    }

    void this.toBytes(data).then((bytes) => this.enqueue('data', { type: BINARY_FRAME, bytes }));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= RawSseSocket.CLOSING) return;

    if (this.readyState === RawSseSocket.CONNECTING) {
      this.finish(1006, '', false);
      return;
    }

    this.readyState = RawSseSocket.CLOSING;
    this.closing = { code, reason };
    this.enqueue('control', {
      type: TEXT_FRAME,
      bytes: new TextEncoder().encode(JSON.stringify(['__close__', { code, reason }, null])),
    });
  }

  private async toBytes(data: Exclude<Data, string>): Promise<Uint8Array> {
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());

    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    }

    return new Uint8Array(data).slice();
  }

  private enqueue(lane: 'data' | 'control', frame: Queued): void {
    this.lanes[lane].queue.push(frame);
    void this.flush(lane);
  }

  /** One POST in flight per lane. A busy answer sends the frames that fit, then the rest. */
  private async flush(name: 'data' | 'control'): Promise<void> {
    const lane = this.lanes[name];
    if (lane.busy || this.secret === null || lane.queue.length === 0) return;

    lane.busy = true;
    try {
      while (lane.queue.length > 0 && this.readyState !== RawSseSocket.CLOSED) {
        const batch = lane.queue.slice(0, MAX_BATCH_FRAMES);
        const response = await fetch(this.httpUrl, {
          method: 'POST',
          headers: { 'LiveThing-Secret': this.secret, 'LiveThing-Lane': name },
          body: encodeBatch(batch),
        });
        if (response.status === 503) {
          const { room, retryAfterMs } = (await response.json()) as {
            room: number;
            retryAfterMs: number;
          };
          if (room > 0) lane.queue.splice(0, room);
          await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
          continue;
        }

        await response.arrayBuffer();
        lane.queue.splice(0, batch.length);
        if (!response.ok) {
          this.fail();
          return;
        }
      }
    } catch {
      this.fail();
    } finally {
      lane.busy = false;
    }
  }

  private async read(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.httpUrl, {
        headers: { Accept: 'text/event-stream' },
        signal: this.stream.signal,
      });
    } catch {
      this.fail();
      return;
    }

    if (!response.ok || !response.body) {
      this.fail();
      return;
    }

    this.readyState = RawSseSocket.OPEN;
    this.fire(new Event('open'), this.onopen);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
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

    if (this.closing) this.finish(this.closing.code, this.closing.reason, true);
    else this.finish(1006, '', false);
  }

  private handleEvent(block: string): void {
    if (this.readyState === RawSseSocket.CLOSED) return;

    const text = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
      .join('\n');
    if (text === '') return;

    if (text.startsWith('["__close__"')) {
      const [, payload] = JSON.parse(text) as [string, { code: number; reason: string }];
      this.finish(payload.code, payload.reason, true);
      return;
    }

    if (this.secret === null && text.startsWith('["__connected__"')) {
      this.secret = (JSON.parse(text) as [string, { secret: string }])[1].secret;
      void this.flush('control');
      void this.flush('data');
    }

    if (text.startsWith('b')) {
      const bytes = decodeBase64(text.slice(1));
      const data = this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
      this.fire(new MessageEvent('message', { data }), this.onmessage);
      return;
    }

    this.fire(new MessageEvent('message', { data: text }), this.onmessage);
  }

  private fail(): void {
    if (this.readyState === RawSseSocket.CLOSED) return;

    this.fire(new Event('error'), this.onerror);
    this.finish(1006, '', false);
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === RawSseSocket.CLOSED) return;

    this.readyState = RawSseSocket.CLOSED;
    this.stream.abort();
    this.lanes.data.queue.length = 0;
    this.lanes.control.queue.length = 0;
    this.fire(new CloseEvent('close', { code, reason, wasClean }), this.onclose);
  }

  private fire<TEvent extends Event>(event: TEvent, handler: ((event: TEvent) => void) | null) {
    handler?.call(this, event);
    this.dispatchEvent(event);
  }
}
