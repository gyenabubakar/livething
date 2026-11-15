import { encodeBinaryFrame, splitBinaryFrame } from '@livething/core';
import { exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const TEXT_FRAME = 0;
const BINARY_FRAME = 1;

function huddleUrl(room: string, query = ''): string {
  return `https://huddle.test/ws/sse?room=${room}${query}`;
}

function worker(url: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(url, init));
}

/** The `data:` events of an open stream, read one at a time. */
class EventReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';

  constructor(response: Response) {
    this.reader = response.body!.getReader();
  }

  /** The next event's data, or `null` once the stream ended. Fails after `ms`. */
  async next(ms = 3_000): Promise<string | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end !== -1) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return block.slice('data: '.length);
      }

      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no event within ${ms}ms`);

      const read = await Promise.race([
        this.reader.read(),
        scheduler.wait(left).then(() => 'timeout' as const),
      ]);
      if (read === 'timeout') throw new Error(`no event within ${ms}ms`);

      if (read.done) return null;

      this.buffer += this.decoder.decode(read.value, { stream: true });
    }
  }

  /** The next event that is not a ping. */
  async nextFrame(ms?: number): Promise<string | null> {
    for (;;) {
      const data = await this.next(ms);
      if (data !== 'ping') return data;
    }
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

function batch(frames: Array<string | Uint8Array>): Uint8Array {
  const parts = frames.map((frame) =>
    typeof frame === 'string' ? new TextEncoder().encode(frame) : frame,
  );
  const body = new Uint8Array(parts.reduce((size, part) => size + 5 + part.byteLength, 0));
  const view = new DataView(body.buffer);
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    body[offset] = typeof frames[index] === 'string' ? TEXT_FRAME : BINARY_FRAME;
    view.setUint32(offset + 1, part.byteLength);
    body.set(part, offset + 5);
    offset += 5 + part.byteLength;
  }

  return body;
}

interface Post {
  url: string;
  secret: string;
  frames: Array<string | Uint8Array>;
  lane?: 'data' | 'control';
}

function post({ url, secret, frames, lane = 'data' }: Post): Promise<Response> {
  return worker(url, {
    method: 'POST',
    headers: { 'LiveThing-Secret': secret, 'LiveThing-Lane': lane },
    body: batch(frames),
  });
}

async function openStream(room: string, query = '') {
  const url = huddleUrl(room, query);
  const response = await worker(url, {
    headers: { Accept: 'text/event-stream', 'LiveThing-Protocol': 'livething-v1' },
  });
  const events = new EventReader(response);
  const connected = JSON.parse((await events.next())!) as [
    string,
    { secret: string; maxPostBytes: number; pingIntervalMs: number | null },
    null,
  ];

  return { url, response, events, connected: connected[1], name: connected[0] };
}

it('opens a stream with the event-stream headers and a __connected__ frame first', async () => {
  const { response, name, connected, events } = await openStream('sse-open');

  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('text/event-stream');
  expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform');
  expect(response.headers.get('X-Accel-Buffering')).toBe('no');
  expect(name).toBe('__connected__');

  expect(connected.secret).toMatch(/^[\w-]{43}$/);
  expect(connected.maxPostBytes).toBe(1024);
  await events.cancel();
});

it('runs keepalive timers for a stream on a hibernating object', async () => {
  const { connected, events } = await openStream('sse-timers');

  expect(connected.pingIntervalMs).toBe(200);
  await expect(events.next()).resolves.toBe('ping');
  await events.cancel();
});

it('keeps a WebSocket in the same object hibernating, with no ping timings', async () => {
  const response = (await worker(huddleUrl('sse-mixed'), {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  const first = new Promise<string>((resolve) => {
    socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
  });
  socket.accept();

  const [, payload] = JSON.parse(await first) as [string, { pingIntervalMs: number | null }];
  expect(payload.pingIntervalMs).toBeNull();
  socket.close(1000, 'done');
});

it('closes a stream whose client never answers a ping with 4004', async () => {
  const { events } = await openStream('sse-idle');

  let close: string | null = null;
  while (close === null) {
    const data = await events.next();
    if (data?.startsWith('["__close__"')) close = data;
  }

  expect(JSON.parse(close)[1]).toMatchObject({ code: 4004 });
  await expect(events.next()).resolves.toBeNull();
});

it('keeps a stream open past the idle timeout while the client answers pings', async () => {
  const { url, connected, events } = await openStream('sse-pong');

  const until = Date.now() + 1_000;
  while (Date.now() < until) {
    const data = await events.next();
    expect(data).toBe('ping');
    const answer = await post({ url, secret: connected.secret, frames: ['pong'], lane: 'control' });
    expect(answer.status).toBe(204);
  }

  await events.cancel();
});

it('delivers a POST in the same room to its stream', async () => {
  const { url, connected, events } = await openStream('sse-room-a', '&username=amara');

  const answer = await post({
    url,
    secret: connected.secret,
    frames: [JSON.stringify(['send-message', { text: 'Standup moved to 10:00' }, null])],
  });

  expect(answer.status).toBe(204);
  expect(JSON.parse((await events.nextFrame())!)).toEqual([
    'message-created',
    { text: 'Standup moved to 10:00', by: 'amara' },
    null,
  ]);
  await events.cancel();
});

it('answers 404 to a POST with the secret of a stream in another room', async () => {
  const { connected, events } = await openStream('sse-room-a2');

  const answer = await post({
    url: huddleUrl('sse-room-b2'),
    secret: connected.secret,
    frames: [JSON.stringify(['send-message', { text: 'wrong room' }, null])],
  });

  expect(answer.status).toBe(404);
  expect(answer.headers.get('LiveThing-Error')).toBe('unknown-connection');
  await events.cancel();
});

it('carries binary frames both ways', async () => {
  const { url, connected, events } = await openStream('sse-binary');
  const avatar = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

  const answer = await post({
    url,
    secret: connected.secret,
    frames: [encodeBinaryFrame(JSON.stringify(['upload-avatar', null, null]), avatar)],
  });

  expect(answer.status).toBe(204);
  const data = (await events.nextFrame())!;
  expect(data.startsWith('b')).toBe(true);
  const frame = splitBinaryFrame(
    Uint8Array.from(atob(data.slice(1)), (char) => char.charCodeAt(0)),
  );
  expect(frame).toEqual({
    kind: 'frame',
    envelope: JSON.stringify(['avatar-preview', { size: 12 }, null]),
    bytes: avatar.subarray(0, 8),
  });

  await events.cancel();
});

it("ends the stream with the server's close code and reason", async () => {
  const { url, connected, events } = await openStream('sse-server-close');

  await post({
    url,
    secret: connected.secret,
    frames: [JSON.stringify(['leave-huddle', {}, null])],
  });

  expect(JSON.parse((await events.nextFrame())!)).toEqual([
    '__close__',
    { code: 4000, reason: 'left the huddle' },
    null,
  ]);
  await expect(events.next()).resolves.toBeNull();
});

it("ends the stream after the client's __close__", async () => {
  const { url, connected, events } = await openStream('sse-client-close');

  const answer = await post({
    url,
    secret: connected.secret,
    frames: [JSON.stringify(['__close__', { code: 1000, reason: 'bye' }, null])],
    lane: 'control',
  });

  expect(answer.status).toBe(204);
  await expect(events.nextFrame()).resolves.toBeNull();
  const late = await post({ url, secret: connected.secret, frames: ['ping'], lane: 'control' });
  expect(late.status).toBe(404);
});

it('answers a reject by close code with a __close__ frame and no __connected__', async () => {
  const response = await worker(huddleUrl('sse-banned', '&banned'), {
    headers: { Accept: 'text/event-stream', 'LiveThing-Protocol': 'livething-v1' },
  });
  const events = new EventReader(response);

  expect(response.status).toBe(200);
  expect(JSON.parse((await events.next())!)).toEqual([
    '__close__',
    { code: 4009, reason: 'Banned from Huddle' },
    null,
  ]);
  await expect(events.next()).resolves.toBeNull();
});

it('answers a reject by HTTP status with that status', async () => {
  const response = await worker(huddleUrl('sse-expired', '&expired'), {
    headers: { Accept: 'text/event-stream', 'LiveThing-Protocol': 'livething-v1' },
  });

  expect(response.status).toBe(401);
  expect(response.headers.get('LiveThing-Error')).toBe('auth');
  await expect(response.text()).resolves.toBe('Log in again');
});

it('answers 413 to a POST body over maxPostBytes', async () => {
  const { url, connected, events } = await openStream('sse-too-large');

  const answer = await post({ url, secret: connected.secret, frames: ['x'.repeat(2_000)] });

  expect(answer.status).toBe(413);
  expect(answer.headers.get('LiveThing-Error')).toBe('too-large');
  await events.cancel();
});

it('answers 426 to a GET that does not ask for an event stream', async () => {
  const response = await worker(huddleUrl('sse-plain-get'));

  expect(response.status).toBe(426);
  expect(response.headers.get('LiveThing-Error')).toBe('not-offered');
});

it('answers a preflight from an allowed origin inside the object', async () => {
  const response = await worker(huddleUrl('sse-preflight'), {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://huddle.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'livething-secret, livething-lane',
    },
  });

  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://huddle.example');
  expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
  expect(response.headers.get('Access-Control-Allow-Headers')).toContain('LiveThing-Secret');
});

it('marks the stream of an allowed origin readable cross-origin', async () => {
  const response = await worker(huddleUrl('sse-cors'), {
    headers: {
      Accept: 'text/event-stream',
      'LiveThing-Protocol': 'livething-v1',
      Origin: 'https://huddle.example',
    },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://huddle.example');
  expect(response.headers.get('Access-Control-Expose-Headers')).toBe('LiveThing-Error');
  await response.body!.cancel();
});

it('refuses another origin with 403 and no CORS headers', async () => {
  const response = await worker(huddleUrl('sse-other-origin'), {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
  });

  expect(response.status).toBe(403);
  expect(response.headers.get('LiveThing-Error')).toBe('origin');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
});

it('accepts a stream whose Origin matches the forwarded Host', async () => {
  const response = await worker(huddleUrl('sse-same-origin'), {
    headers: {
      Accept: 'text/event-stream',
      'LiveThing-Protocol': 'livething-v1',
      Origin: 'https://huddle.test',
    },
  });

  expect(response.status).toBe(200);
  await response.body!.cancel();
});
