import { http } from '~/transports/http.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport, TransportEvents } from '~/transports/transport.ts';

const TEXT = 0;
const PROBE = 2;
const START = 3;

interface Frame {
  type: number;
  text: string;
  bytes: Uint8Array;
}

function parseFrames(body: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (let offset = 0; offset + 5 <= body.byteLength; ) {
    const length = view.getUint32(offset + 1, false);
    const bytes = body.slice(offset + 5, offset + 5 + length);
    frames.push({ type: body[offset]!, text: new TextDecoder().decode(bytes), bytes });
    offset += 5 + length;
  }

  return frames;
}

interface Post {
  lane: string | null;
  seq: string | null;
  frames: Frame[];
  answer(status: number): void;
}

/** The long POST, read as the client writes it. */
class Upload {
  bytes = new Uint8Array(0);
  chunks = 0;
  ended = false;
  headers: Headers;
  private settle!: { resolve(response: Response): void; reject(error: unknown): void };
  readonly response: Promise<Response>;

  constructor(init: RequestInit) {
    this.headers = new Headers(init.headers);
    this.response = new Promise((resolve, reject) => (this.settle = { resolve, reject }));
    init.signal?.addEventListener('abort', () =>
      this.settle.reject(new DOMException('aborted', 'AbortError')),
    );
    void this.read(init.body as ReadableStream<Uint8Array>);
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        this.chunks++;
        const joined = new Uint8Array(this.bytes.byteLength + value.byteLength);
        joined.set(this.bytes);
        joined.set(value, this.bytes.byteLength);
        this.bytes = joined;
      }

      this.ended = true;
    } catch {}
  }

  frames(): Frame[] {
    return parseFrames(this.bytes);
  }

  /** The app frames, after the probes and the start frame. */
  texts(): string[] {
    return this.frames()
      .filter((frame) => frame.type === TEXT)
      .map((frame) => frame.text);
  }

  answer(status: number): void {
    this.settle.resolve(new Response(null, { status }));
  }

  fail(): void {
    this.settle.reject(new TypeError('Failed to fetch'));
  }
}

class FakeServer {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  posts: Post[] = [];
  uploads: Upload[] = [];
  /** When set, control POSTs wait for `answer` instead of getting 204 at once. */
  holdControl = false;

  fetch = vi.fn(async (_url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (init.method === 'POST' && headers.get('LiveThing-Upload') === 'stream') {
      const upload = new Upload(init);
      this.uploads.push(upload);
      return upload.response;
    }

    if (init.method === 'POST') {
      return new Promise<Response>((resolve) => {
        const post: Post = {
          lane: headers.get('LiveThing-Lane'),
          seq: headers.get('LiveThing-Seq'),
          frames: parseFrames(init.body as Uint8Array),
          answer: (status) => resolve(new Response(null, { status })),
        };

        this.posts.push(post);
        if (!(this.holdControl && post.lane === 'control')) post.answer(204);
      });
    }

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    this.controller = controller;
    init.signal?.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('aborted', 'AbortError'));
      } catch {}
    });

    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });

  drop(): void {
    this.controller.error(new TypeError('network error'));
  }

  event(text: string): void {
    this.controller.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));
  }

  accept(maxPostBytes = 1024): void {
    this.event(
      JSON.stringify([
        '__connected__',
        { connectionId: 'c_kofi', secret: 's3cret', maxPostBytes },
        null,
      ]),
    );
  }

  ack(seq: number, probe = false): void {
    this.event(JSON.stringify(['__ack__', probe ? { seq, probe: true } : { seq }, null]));
  }

  get upload(): Upload {
    const upload = this.uploads.at(-1);
    if (!upload) throw new Error('no upload opened');

    return upload;
  }

  dataPosts(): Post[] {
    return this.posts.filter((post) => post.lane === 'data');
  }

  controlTexts(): string[] {
    return this.posts
      .filter((post) => post.lane === 'control')
      .flatMap((post) => post.frames.map((frame) => frame.text));
  }
}

function sendMessage(text: string): string {
  return JSON.stringify(['send-message', { text }, null]);
}

let server: FakeServer;
let origin = 0;

function events(): TransportEvents & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    open: vi.fn(),
    message: (data) => void messages.push(data),
    close: vi.fn(),
    error: vi.fn(),
    stable: vi.fn(),
    unusable: vi.fn(),
  };
}

/** Each test gets its own origin, so a failure one test remembers does not reach the next. */
function open(url = `https://huddle${++origin}.example/huddle`): {
  transport: Transport;
  events: ReturnType<typeof events>;
} {
  const transportEvents = events();
  const transport = http().open({
    url,
    protocols: undefined,
    token: null,
    binary: false,
    warn: () => {},
    events: transportEvents,
  });
  return { transport, events: transportEvents };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Opens a transport, accepts it, and lands one POST, so the client tries the upload. */
async function openAndTry(url?: string): Promise<Transport> {
  const { transport } = open(url);
  await flush();
  server.accept();
  await flush();
  transport.send(sendMessage('hello'));

  await flush();

  return transport;
}

/** As `openAndTry`, then acks the probe, so the client moves to the upload. */
async function openInStreamMode(): Promise<Transport> {
  const transport = await openAndTry();
  server.ack(1, true);
  await flush();
  return transport;
}

beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal('fetch', server.fetch);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('http(): batch mode', () => {
  it('numbers the frames of each data POST', async () => {
    const { transport } = open();
    await flush();
    server.accept();
    await flush();

    transport.send(sendMessage('one'));
    await flush();
    // Two goes at once; three and four wait for its POST, and go together.
    transport.send(sendMessage('two'));
    transport.send(sendMessage('three'));
    transport.send(sendMessage('four'));
    await flush();
    transport.send(sendMessage('five'));

    await flush();

    expect(server.dataPosts().map((post) => [post.seq, post.frames.length])).toEqual([
      ['1', 1],
      ['2', 1],
      ['3', 2],
      ['5', 1],
    ]);
  });
});

describe('http(): stream mode', () => {
  it('does not open an upload when a POST lands after the connection dropped', async () => {
    const url = 'https://huddle-late-answer.example/huddle';
    server.holdControl = true;
    const { transport } = open(url);
    await flush();
    server.accept();

    await flush();
    transport.sendControl('pong');
    await flush();

    server.drop();
    await flush();
    server.posts.at(-1)!.answer(204);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(server.uploads).toHaveLength(0);
    server.holdControl = false;
    await openAndTry(url);
    expect(server.uploads).toHaveLength(1);
  });

  it('opens one long POST after the first POST lands, with a probe frame first', async () => {
    await openAndTry();

    expect(server.uploads).toHaveLength(1);
    expect(server.upload.headers.get('LiveThing-Lane')).toBe('data');
    expect(server.upload.headers.get('LiveThing-Secret')).toBe('s3cret');
    expect(server.upload.frames().map((frame) => frame.type)).toEqual([PROBE]);
  });

  it('moves the sends to the upload once the probe is acked', async () => {
    const transport = await openInStreamMode();

    transport.send(sendMessage('two'));
    transport.send(sendMessage('three'));
    await flush();

    const [, start, ...rest] = server.upload.frames();
    expect(start).toMatchObject({ type: START });
    expect(new DataView(start!.bytes.buffer).getUint32(0, false)).toBe(2);
    expect(rest.map((frame) => frame.text)).toEqual([sendMessage('two'), sendMessage('three')]);
    expect(server.dataPosts()).toHaveLength(1);
  });

  it('writes the sends of one tick in one chunk', async () => {
    const transport = await openInStreamMode();
    const chunksBefore = server.upload.chunks;

    for (let i = 0; i < 50; i++) transport.send(sendMessage(`m${i}`));
    await flush();

    expect(server.upload.texts()).toHaveLength(50);
    expect(server.upload.chunks - chunksBefore).toBe(1);
  });

  it('stays in batch mode when the probe ack does not come in 2 seconds', async () => {
    const transport = await openAndTry();

    await vi.advanceTimersByTimeAsync(2_000);
    transport.send(sendMessage('two'));
    await flush();

    expect(server.dataPosts().map((post) => post.seq)).toEqual(['1', '2']);
    await expect(server.upload.response).rejects.toThrow();
  });

  it('remembers a failed probe for the origin, so the next connection does not try', async () => {
    const url = 'https://huddle-remembers.example/huddle';
    const first = await openAndTry(url);
    await vi.advanceTimersByTimeAsync(2_000);
    first.close();

    await openAndTry(url);

    expect(server.uploads).toHaveLength(1);
  });

  it('stays in batch mode when the upload fetch fails', async () => {
    const transport = await openAndTry();

    server.upload.fail();
    await flush();
    transport.send(sendMessage('two'));
    await flush();

    expect(server.dataPosts().map((post) => post.seq)).toEqual(['1', '2']);
  });

  it('does not try over HTTP/1.1', async () => {
    vi.stubGlobal('performance', {
      now: () => 0,
      getEntriesByName: () => [{ nextHopProtocol: 'http/1.1' }],
    });

    await openAndTry();

    expect(server.uploads).toHaveLength(0);
  });

  it('does not try where fetch cannot stream a request body', async () => {
    // Firefox and Safari never read `duplex`, and give the stream body a text Content-Type.
    vi.stubGlobal(
      'Request',
      class {
        headers = new Headers({ 'Content-Type': 'text/plain;charset=UTF-8' });
      },
    );

    await openAndTry();

    expect(server.uploads).toHaveLength(0);
  });

  it('resends the frames that were not acked by POST when the upload dies', async () => {
    const transport = await openInStreamMode();
    transport.send(sendMessage('two'));
    transport.send(sendMessage('three'));
    transport.send(sendMessage('four'));
    await flush();

    server.ack(2);
    await flush();

    server.upload.fail();
    await flush();

    const resend = server.dataPosts().at(-1)!;
    expect(resend.seq).toBe('3');
    expect(resend.frames.map((frame) => frame.text)).toEqual([
      sendMessage('three'),
      sendMessage('four'),
    ]);
  });

  it('holds frames past the window until acks come', async () => {
    const transport = await openInStreamMode();
    // maxPostBytes is 1024, so the window is 4 KiB of frames written and not acked.
    const big = sendMessage('x'.repeat(900));
    for (let i = 0; i < 8; i++) transport.send(big);
    await flush();

    const written = server.upload.texts().length;
    expect(written).toBeLessThan(8);

    server.ack(1 + written);
    await flush();

    expect(server.upload.texts()).toHaveLength(8);
    expect(transport.bufferedAmount()).toBeGreaterThan(0);
  });

  it('closes in order: ends the upload, waits for its last ack, then sends __close__', async () => {
    const transport = await openInStreamMode();
    transport.send(sendMessage('two'));
    await flush();

    transport.close(1000, 'bye');
    await flush();

    expect(server.upload.ended).toBe(true);
    expect(server.controlTexts()).toEqual([]);

    server.ack(2);
    await flush();
    await flush();

    expect(server.controlTexts()).toEqual([
      JSON.stringify(['__close__', { code: 1000, reason: 'bye' }, null]),
    ]);
  });

  it('starts a fresh upload after 8 MiB, from the first frame without an ack, with no probe', async () => {
    const { transport } = open();
    await flush();
    server.accept(512 * 1024);
    await flush();
    transport.send(sendMessage('hello'));

    await flush();
    server.ack(1, true);
    await flush();

    function big(i: number): string {
      return sendMessage(`${i}:${'x'.repeat(400 * 1024)}`);
    }

    // Each frame is acked, except the last one written to the first upload.
    for (let i = 2; i <= 22; i++) {
      transport.send(big(i));
      await flush();
      if (server.uploads.length === 1) server.ack(i);
      await flush();
    }

    expect(server.uploads).toHaveLength(2);
    const [first, second] = server.uploads as [Upload, Upload];
    expect(first.ended).toBe(true);
    const [start] = second.frames();
    expect(start).toMatchObject({ type: START });

    const resentFrom = new DataView(start!.bytes.buffer).getUint32(0, false);
    expect(second.frames().some((frame) => frame.type === PROBE)).toBe(false);
    // Every frame arrives, in order, across the two uploads.
    const firstTexts = first.texts().slice(0, resentFrom - 2);
    expect([...firstTexts, ...second.texts()]).toEqual(
      Array.from({ length: 21 }, (_, i) => big(i + 2)),
    );
  });

  it('renews once when the frames it writes again are over 8 MiB', async () => {
    const { transport } = open();
    await flush();
    server.accept(5 * 1024 * 1024);
    await flush();
    transport.send(sendMessage('hello'));

    await flush();
    server.ack(1, true);
    await flush();

    for (let i = 0; i < 3; i++) transport.send(sendMessage(`${i}:${'x'.repeat(3 * 1024 * 1024)}`));
    await flush();
    await flush();

    expect(server.uploads).toHaveLength(2);
  });

  it('does not renew while it closes, and waits for the last frames', async () => {
    const { transport } = open();
    await flush();
    server.accept(512 * 1024);
    await flush();
    transport.send(sendMessage('hello'));

    await flush();
    server.ack(1, true);
    await flush();
    // 20 frames of 400 KiB, each acked: the upload is just under 8 MiB.
    for (let i = 2; i <= 21; i++) {
      transport.send(sendMessage(`${i}:${'x'.repeat(400 * 1024)}`));
      await flush();
      server.ack(i);
      await flush();
    }

    transport.send(sendMessage(`last:${'x'.repeat(400 * 1024)}`));
    transport.close(1000, 'bye');
    await flush();

    expect(server.uploads).toHaveLength(1);
    expect(server.controlTexts()).toEqual([]);
    server.ack(22);
    await flush();
    await flush();

    expect(server.controlTexts()).toHaveLength(1);
  });

  it('delivers a send made just before close', async () => {
    const transport = await openInStreamMode();

    transport.send(sendMessage('last'));
    transport.close(1000, 'bye');
    await flush();

    expect(server.upload.texts()).toContain(sendMessage('last'));
  });

  it('does not remember a missed idle probe for the origin, once the upload worked', async () => {
    const url = 'https://huddle-idle-probe.example/huddle';
    const first = await openAndTry(url);
    server.ack(1, true);
    await flush();

    await vi.advanceTimersByTimeAsync(32_000);
    first.close();
    await flush();
    await openAndTry(url);

    expect(server.uploads).toHaveLength(2);
  });

  it('sends a probe on an idle upload, and moves back to POSTs when its ack does not come', async () => {
    const transport = await openInStreamMode();
    function probes(): number {
      return server.upload.frames().filter((frame) => frame.type === PROBE).length;
    }

    // The first check sees the start frame written; the second sees nothing.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probes()).toBe(2);

    await vi.advanceTimersByTimeAsync(2_000);
    transport.send(sendMessage('two'));
    await flush();

    expect(
      server
        .dataPosts()
        .at(-1)!
        .frames.map((frame) => frame.text),
    ).toEqual([sendMessage('two')]);
  });

  it('does not pass an ack to the socket', async () => {
    const { events: transportEvents } = open();
    await flush();
    server.accept();
    await flush();
    server.ack(0, true);

    await flush();

    expect(transportEvents.messages.every((message) => !String(message).includes('__ack__'))).toBe(
      true,
    );
  });
});
