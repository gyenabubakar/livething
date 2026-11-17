import { binary, client, connect, http } from '@livething/client';
import { exports } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InferClient } from '@livething/server';
import type { httpDefinition } from '../src/http.ts';

type HuddleClient = InferClient<typeof httpDefinition>;

// The client's fetch reaches this test Worker, so its stream and POSTs reach the real object.
const networkFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (input, init) => exports.default.fetch(new Request(input, init));
});
afterEach(() => {
  globalThis.fetch = networkFetch;
});

function open(room: string, query = '') {
  const socket = client<HuddleClient>()(
    connect(`https://huddle.test/ws/http?room=${room}${query}`, { transports: [http()] }),
    binary(),
  );
  const closes: { code: number; reason: string }[] = [];
  socket.onClose((event) => closes.push({ code: event.code, reason: event.reason }));
  socket.onError(() => {});
  socket.connect();

  return { socket, closes };
}

/** The first open of a test run also starts the Worker and the object, which takes over 1 s. */
function opened(socket: ReturnType<typeof open>['socket']): Promise<void> {
  return vi.waitFor(() => expect(socket.state.get()).toBe('open'), { timeout: 15_000 });
}

it('connects over http(), and carries messages both ways in order', async () => {
  const { socket } = open('client-order', '&username=kofi');
  const received: string[] = [];
  socket.on('message-created', (message) => received.push(`${message.by}:${message.text}`));

  await opened(socket);
  expect(socket.transport.get()).toBe('http');
  for (let i = 0; i < 300; i++) socket.send('send-message', { text: String(i) });

  await vi.waitFor(() => expect(received).toHaveLength(300), { timeout: 10_000 });
  expect(received).toEqual(Array.from({ length: 300 }, (_, i) => `kofi:${i}`));
  socket.disconnect();
});

it('carries binary messages both ways', async () => {
  const { socket } = open('client-binary');
  const previews: Array<{ size: number; bytes: number[] }> = [];
  socket.binary.on('avatar-preview', (info, bytes) =>
    previews.push({ ...info, bytes: [...bytes] }),
  );
  await opened(socket);

  socket.binary.send(
    'upload-avatar',
    Uint8Array.from({ length: 600 }, (_, i) => i % 256),
    { info: null },
  );

  await vi.waitFor(() =>
    expect(previews).toEqual([{ size: 600, bytes: [0, 1, 2, 3, 4, 5, 6, 7] }]),
  );
  socket.disconnect();
});

it("gives the client the server's close code and reason", async () => {
  const { socket, closes } = open('client-server-close');
  await opened(socket);

  socket.send('leave-huddle', undefined);

  await vi.waitFor(() => expect(closes).toEqual([{ code: 4000, reason: 'left the huddle' }]));
});

it('keeps a quiet connection open past the idle timeout with pings and pongs', async () => {
  const { socket, closes } = open('client-quiet');
  await opened(socket);

  await new Promise((resolve) => setTimeout(resolve, 1_500));

  expect(socket.state.get()).toBe('open');
  expect(closes).toEqual([]);
  socket.disconnect();
});

it('reports a reject by close code as that close, with no open', async () => {
  const { socket, closes } = open('client-banned', '&banned');
  let opened = false;
  socket.onOpen(() => {
    opened = true;
  });

  await vi.waitFor(() => expect(closes).toEqual([{ code: 4009, reason: 'Banned from Huddle' }]));
  expect(opened).toBe(false);
});
