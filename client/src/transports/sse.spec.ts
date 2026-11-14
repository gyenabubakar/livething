import { CloseCodes, encodeBinaryFrame } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { binary } from '~/primitives/binary/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { keepalive } from '~/primitives/keepalive/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { sse } from '~/transports/sse.ts';
import { websocket } from '~/transports/websocket.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectOptions } from '~/connect.ts';
import type { Primitive } from '~/primitives/types.ts';

interface HuddleContract {
  incoming: { messageCreated: { text: string } };
  outgoing: { sendMessage: { text: string } };
}

interface SentPost {
  lane: string | null;
  secret: string | null;
  frames: { binary: boolean; text: string; bytes: Uint8Array }[];
  answer(status: number, init?: { headers?: Record<string, string>; body?: string }): void;
}

/** A fake server behind `fetch`: one stream, and every POST, answered by hand. */
class FakeServer {
  streams: { url: string; headers: Headers; push(text: string): void; end(): void }[] = [];
  posts: SentPost[] = [];
  /** How the next stream request is answered. A `Response` replaces the stream. */
  nextStream: Response | null = null;
  autoAnswer = true;

  fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (init.method === 'POST') return this.post(headers, init.body as Uint8Array);

    if (this.nextStream) {
      const response = this.nextStream;
      this.nextStream = null;
      return response;
    }

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    init.signal?.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('aborted', 'AbortError'));
      } catch {}
    });
    this.streams.push({
      url,
      headers,
      push: (text) => controller.enqueue(new TextEncoder().encode(text)),
      end: () => controller.close(),
    });

    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });

  private post(headers: Headers, body: Uint8Array): Promise<Response> {
    return new Promise((resolve) => {
      const post: SentPost = {
        lane: headers.get('LiveThing-Lane'),
        secret: headers.get('LiveThing-Secret'),
        frames: parseBatch(body),
        answer: (status, init = {}) =>
          resolve(new Response(init.body ?? null, { status, headers: init.headers })),
      };

      this.posts.push(post);
      if (this.autoAnswer) post.answer(204);
    });
  }

  get stream() {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error('no stream opened yet');

    return stream;
  }

  event(text: string): void {
    this.stream.push(`data: ${text}\n\n`);
  }

  accept(fields: Record<string, unknown> = {}): void {
    this.event(
      JSON.stringify([
        '__connected__',
        {
          pingIntervalMs: null,
          idleTimeoutMs: null,
          maxResumeTokens: 8,
          connectionId: 'c_kofi',
          features: ['replay', 'binary', 'uploads'],
          resume: null,
          secret: 's3cret',
          maxPostBytes: 1024,
          ...fields,
        },
        null,
      ]),
    );
  }

  /** The app frames of every data POST, in order. */
  dataTexts(): string[] {
    return this.posts
      .filter((post) => post.lane === 'data')
      .flatMap((post) => post.frames.map((f) => f.text));
  }
}

function parseBatch(body: Uint8Array): SentPost['frames'] {
  const frames: SentPost['frames'] = [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (let offset = 0; offset < body.byteLength; ) {
    const length = view.getUint32(offset + 1, false);
    const bytes = body.subarray(offset + 5, offset + 5 + length);
    frames.push({ binary: body[offset] === 1, text: new TextDecoder().decode(bytes), bytes });
    offset += 5 + length;
  }

  return frames;
}

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal('fetch', server.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function open(options: ConnectOptions = {}, ...primitives: Primitive[]) {
  const socket = client<HuddleContract>()(
    connect('wss://huddle.test/huddle?room=design', { transports: [sse()], ...options }),
    ...(primitives as []),
  );
  const closes: { code: number; reason: string }[] = [];
  const errors: unknown[] = [];
  socket.onClose((event) => closes.push({ code: event.code, reason: event.reason }));
  socket.onError((error) => errors.push(error));

  socket.connect();

  return { socket, closes, errors };
}

async function opened(options: ConnectOptions = {}, ...primitives: Primitive[]) {
  const result = open(options, ...primitives);
  await vi.waitFor(() => expect(server.streams).toHaveLength(1));
  server.accept();
  await vi.waitFor(() => expect(result.socket.state.get()).toBe('open'));

  return result;
}

function sendMessage(text: string): string {
  return JSON.stringify(['sendMessage', { text }, null]);
}

describe('sse(): the stream', () => {
  it('asks for an event stream at the http URL, with the token as a bearer token', async () => {
    open({ token: () => 'kofi-token' });

    await vi.waitFor(() => expect(server.streams).toHaveLength(1));
    expect(server.stream.url).toBe('https://huddle.test/huddle?room=design');
    expect(server.stream.headers.get('Accept')).toBe('text/event-stream');
    expect(server.stream.headers.get('Authorization')).toBe('Bearer kofi-token');
  });

  it('sends the LiveThing-Protocol header on the stream request', async () => {
    open();

    await vi.waitFor(() => expect(server.streams).toHaveLength(1));
    expect(server.stream.headers.get('LiveThing-Protocol')).toBe('livething-v1');
  });

  it('reads an event split across many chunks and a blank line split between two', async () => {
    const { socket } = await opened();
    const texts: string[] = [];
    socket.on('messageCreated', ({ text }) => texts.push(text));
    const text = 'x'.repeat(200_000);
    const wire = `data: ${JSON.stringify(['messageCreated', { text }, null])}\n\ndata: ${JSON.stringify(['messageCreated', { text: 'b' }, null])}\n`;

    for (let i = 0; i < wire.length; i += 16_384) server.stream.push(wire.slice(i, i + 16_384));
    server.stream.push('\n');

    await vi.waitFor(() => expect(texts).toEqual([text, 'b']));
  });

  it('rejects a queued request over maxPostBytes and still sends the ones after it', async () => {
    const socket = client<HuddleContract>()(
      connect('wss://huddle.test/huddle?room=design', { transports: [sse()] }),
      clientRequests(),
    );
    const errors: unknown[] = [];
    socket.onError((error) => errors.push(error));
    socket.connect();

    const tooBig = socket.request('sendMessage' as never, { text: 'x'.repeat(2000) } as never);
    const fine = socket.request('sendMessage' as never, { text: 'ok' } as never);
    void fine.catch(() => undefined);
    await vi.waitFor(() => expect(server.streams).toHaveLength(1));
    server.accept();

    await expect(tooBig).rejects.toThrow(/over the server's POST limit/);
    await vi.waitFor(() => expect(server.dataTexts().join()).toContain('"ok"'));
    expect(errors).toHaveLength(1);
  });

  it('opens on the __connected__ frame, and reports the transport as sse', async () => {
    const { socket } = await opened();

    expect(socket.transport.get()).toBe('sse');
    expect(socket.ws).toBeNull();
  });

  it('delivers app frames and base64 binary frames', async () => {
    const { socket } = await opened({}, binary() as Primitive);
    const texts: unknown[] = [];
    const previews: number[][] = [];
    socket.on('messageCreated', (payload) => texts.push(payload));
    (
      socket as unknown as {
        binary: { on(e: string, h: (i: unknown, b: Uint8Array) => void): void };
      }
    ).binary.on('avatar-preview', (_info, bytes) => previews.push([...bytes]));

    server.event(JSON.stringify(['messageCreated', { text: 'hi' }, null]));
    const frame = encodeBinaryFrame(
      JSON.stringify(['avatar-preview', null, null]),
      new Uint8Array([9, 8]),
    );
    server.event(`b${Buffer.from(frame).toString('base64')}`);

    await vi.waitFor(() => expect(previews).toEqual([[9, 8]]));
    expect(texts).toEqual([{ text: 'hi' }]);
  });

  it("closes with the server's __close__ code and reason", async () => {
    const { socket, closes } = await opened();

    server.event(JSON.stringify(['__close__', { code: 4003, reason: 'replaced' }, null]));

    await vi.waitFor(() => expect(closes).toEqual([{ code: 4003, reason: 'replaced' }]));
    expect(socket.state.get()).toBe('closed');
  });

  it('treats a stream that ends with no __close__ as an abnormal close', async () => {
    const { closes } = await opened();

    server.stream.end();

    await vi.waitFor(() =>
      expect(closes).toEqual([{ code: 1006, reason: 'stream ended without a close' }]),
    );
  });

  it('reports a reject by close code before __connected__ with no open', async () => {
    const { socket, closes } = open();
    const states: string[] = [];
    socket.state.subscribe((state) => states.push(state));
    await vi.waitFor(() => expect(server.streams).toHaveLength(1));

    server.event(JSON.stringify(['__close__', { code: 4009, reason: 'Banned' }, null]));

    await vi.waitFor(() => expect(closes).toEqual([{ code: 4009, reason: 'Banned' }]));
    expect(states).not.toContain('open');
  });

  it.each([
    [401, true, 4001],
    [403, true, 4002],
    [429, true, 4005],
    [418, true, 4002],
    [404, true, 1006],
    [426, true, 1006],
    [503, true, 1006],
    [401, false, 1006],
    [403, false, 1006],
  ])(
    'maps a stream answer of %i (LiveThing-Error: %s) to close %i',
    async (status, marked, code) => {
      server.nextStream = new Response('Log in again', {
        status,
        headers: marked ? { 'LiveThing-Error': 'auth' } : {},
      });

      const { closes } = open();

      await vi.waitFor(() => expect(closes.map((close) => close.code)).toEqual([code]));
    },
  );
});

describe('sse(): sending', () => {
  it('POSTs a frame on the data lane, with the secret', async () => {
    const { socket } = await opened();

    socket.send('sendMessage', { text: 'hi' });

    await vi.waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]).toMatchObject({ lane: 'data', secret: 's3cret' });
    expect(server.dataTexts()).toEqual([sendMessage('hi')]);
  });

  it('sends one POST at a time, and batches what queued meanwhile, in order', async () => {
    server.autoAnswer = false;
    const { socket } = await opened();

    socket.send('sendMessage', { text: '1' });
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));
    socket.send('sendMessage', { text: '2' });
    socket.send('sendMessage', { text: '3' });
    expect(server.posts).toHaveLength(1);

    expect(socket.ws).toBeNull();

    server.posts[0]!.answer(204);
    await vi.waitFor(() => expect(server.posts).toHaveLength(2));

    expect(server.posts[1]!.frames.map((frame) => frame.text)).toEqual([
      sendMessage('2'),
      sendMessage('3'),
    ]);
  });

  it('answers a server ping with a pong on the control lane', async () => {
    await opened();

    server.event('ping');

    await vi.waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]).toMatchObject({ lane: 'control' });
    expect(server.posts[0]!.frames.map((frame) => frame.text)).toEqual(['pong']);
  });

  it('refuses a message over maxPostBytes, and stays open', async () => {
    const { socket } = await opened();

    expect(() => socket.send('sendMessage', { text: 'x'.repeat(1100) })).toThrow(
      /over the server's POST limit of 1019 bytes/,
    );
    expect(socket.state.get()).toBe('open');
  });

  it('after a busy answer, waits at least 250 ms, then sends only the room the server gave', async () => {
    server.autoAnswer = false;
    const { socket } = await opened();
    for (let i = 0; i < 5; i++) socket.send('sendMessage', { text: String(i) });
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));
    server.posts[0]!.answer(204);

    await vi.waitFor(() => expect(server.posts).toHaveLength(2));
    expect(server.posts[1]!.frames).toHaveLength(4);

    const refusedAt = Date.now();
    server.posts[1]!.answer(503, {
      headers: { 'LiveThing-Error': 'busy' },
      body: JSON.stringify({ room: 2, retryAfterMs: 0 }),
    });

    await vi.waitFor(() => expect(server.posts).toHaveLength(3), { timeout: 2000 });
    expect(Date.now() - refusedAt).toBeGreaterThanOrEqual(245);
    expect(server.posts[2]!.frames.map((frame) => frame.text)).toEqual([
      sendMessage('1'),
      sendMessage('2'),
    ]);
    expect(socket.state.get()).toBe('open');
  });

  it.each([
    [404, {}],
    [500, {}],
    [413, {}],
    [503, {}],
  ])('drops the connection when a POST gets %i', async (status, headers) => {
    server.autoAnswer = false;
    const { socket, closes } = await opened();
    socket.send('sendMessage', { text: 'hi' });
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));

    server.posts[0]!.answer(status, { headers });

    await vi.waitFor(() => expect(closes.map((close) => close.code)).toEqual([1006]));
  });

  it('closes with AUTH_INVALID when a POST gets a 403 from LiveThing', async () => {
    server.autoAnswer = false;
    const { socket, closes } = await opened();
    socket.send('sendMessage', { text: 'hi' });
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));

    server.posts[0]!.answer(403, { headers: { 'LiveThing-Error': 'origin' } });

    await vi.waitFor(() => expect(closes.map((close) => close.code)).toEqual([4002]));
  });

  it('reports the bytes queued and not yet POSTed as bufferedAmount', async () => {
    server.autoAnswer = false;
    const { socket } = await opened();

    socket.send('sendMessage', { text: 'a' });
    socket.send('sendMessage', { text: 'b' });

    const transport = (socket as unknown as { _transport: { bufferedAmount(): number } })
      ._transport;
    expect(transport.bufferedAmount()).toBe(2 * sendMessage('a').length);
  });
});

describe('sse(): closing', () => {
  it('lets the data POST in flight land, then sends __close__ on the control lane, then stops the stream', async () => {
    server.autoAnswer = false;
    const { socket } = await opened();
    socket.send('sendMessage', { text: 'last words' });
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));

    socket.disconnect(4100, 'tab closed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.posts).toHaveLength(1);

    server.posts[0]!.answer(204);
    await vi.waitFor(() => expect(server.posts).toHaveLength(2));
    expect(server.posts[1]).toMatchObject({ lane: 'control' });
    expect(server.posts[1]!.frames.map((frame) => frame.text)).toEqual([
      JSON.stringify(['__close__', { code: 4100, reason: 'tab closed' }, null]),
    ]);
    expect(socket.state.get()).toBe('closed');
  });

  it('drops queued frames that were not POSTed yet', async () => {
    server.autoAnswer = false;
    const { socket } = await opened();
    socket.send('sendMessage', { text: '1' });
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));
    socket.send('sendMessage', { text: 'never sent' });

    socket.disconnect();
    server.posts[0]!.answer(204);
    await vi.waitFor(() => expect(server.posts).toHaveLength(2));
    server.posts[1]!.answer(204);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.dataTexts()).toEqual([sendMessage('1')]);
  });

  it('only aborts the stream when it closes before __connected__', async () => {
    const { socket } = open();
    await vi.waitFor(() => expect(server.streams).toHaveLength(1));

    socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.posts).toEqual([]);
  });
});

describe('sse(): a POST that fails before any POST worked', () => {
  let restoreWebSocket: () => void;
  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
  });
  afterEach(() => {
    restoreWebSocket();
  });

  async function firstPostAnswered(status: number) {
    server.autoAnswer = false;
    const { socket } = await opened(
      { transports: [sse(), websocket()] },
      reconnection({ maxDelay: 1 }),
    );
    socket.send('sendMessage', { text: 'hi' });
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));

    server.posts[0]!.answer(status);
  }

  it('skips sse on the next open, so the WebSocket is tried', async () => {
    await firstPostAnswered(500);

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(server.streams).toHaveLength(1);
  });

  it('keeps sse after a 404, which only means the server forgot the connection', async () => {
    await firstPostAnswered(404);

    await vi.waitFor(() => expect(server.streams).toHaveLength(2));
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe('sse() and keepalive()', () => {
  it('closes a stream that hangs after its first frame, and opens a new one', async () => {
    vi.useFakeTimers();
    const { socket, closes } = open({}, keepalive(), reconnection({ maxDelay: 1 }));
    await vi.waitFor(() => expect(server.streams).toHaveLength(1));
    server.accept({ pingIntervalMs: 1_000, idleTimeoutMs: 3_000 });
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    // The stream stays open but sends nothing more: no pong ever comes back.
    await vi.advanceTimersByTimeAsync(4_000);

    expect(closes.map((close) => close.code)).toEqual([CloseCodes.IDLE]);
    await vi.waitFor(() => expect(server.streams).toHaveLength(2));
  });
});

describe('sse() and reconnection()', () => {
  it('resets the attempt count only after 30 s open with one POST accepted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { socket } = open({}, reconnection() as Primitive);
    const { reconnection: store } = socket as unknown as {
      reconnection: { get(): { attempt: number } };
    };
    function reconnecting() {
      return store;
    }

    await vi.waitFor(() => expect(server.streams).toHaveLength(1));

    server.stream.end();
    await vi.waitFor(() => expect(reconnecting().get().attempt).toBe(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(server.streams).toHaveLength(2));
    server.accept();

    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    server.stream.end();
    await vi.waitFor(() => expect(reconnecting().get().attempt).toBe(2));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(server.streams).toHaveLength(3));
    server.accept();

    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));
    socket.send('sendMessage', { text: 'hi' });
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(30_000);

    server.stream.end();
    await vi.waitFor(() => expect(reconnecting().get().attempt).toBe(1));
  });
});
