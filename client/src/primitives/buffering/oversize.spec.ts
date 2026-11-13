import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '~/internal/runtime.ts';

interface C {
  outgoing: { 'send-message': { text: string } };
  clientRequests: {
    'upload-avatar': { payload: { image: string }; response: { url: string } };
  };
  streams: { 'ask-ai': { payload: { prompt: string }; chunk: { text: string } } };
}

const MAX_BYTES = 200;
const big = 'x'.repeat(MAX_BYTES);

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

function build(flushInterval = 0) {
  const socket = client<C>()(
    connect('wss://test'),
    buffering({ maxBytes: MAX_BYTES, flushInterval }),
    clientRequests(),
    stream(),
  );
  socket.connect();
  return { socket, ws: MockWebSocket.last() };
}

function texts(frames: Message[]): string[] {
  return frames
    .filter((frame) => frame.event === 'send-message')
    .map((frame) => (frame.payload as { text: string }).text);
}

describe('buffering — a message bigger than maxBytes', () => {
  it('is refused while offline: send returns false, and the queue keeps what it had', () => {
    const { socket, ws } = build();

    expect(socket.send('send-message', { text: 'small' })).toBe(true);
    expect(socket.send('send-message', { text: big })).toBe(false);
    ws.open();

    expect(texts(ws.sentFrames())).toEqual(['small']);
  });

  it('rejects a request with Dropped at once', async () => {
    const { socket } = build();

    await expect(socket.request('upload-avatar', { image: big })).rejects.toMatchObject({
      code: 'dropped',
    });
  });

  it('rejects a stream with Dropped at once', async () => {
    const { socket } = build();

    await expect(socket.stream('ask-ai', { prompt: big })).rejects.toMatchObject({
      code: 'dropped',
    });
  });

  it('queues a message of exactly maxBytes, and refuses one byte more', () => {
    const { socket, ws } = build();
    // ["send-message",{"text":""},null] is 33 bytes.
    const fits = 'y'.repeat(MAX_BYTES - 33);

    expect(socket.send('send-message', { text: fits })).toBe(true);
    expect(socket.send('send-message', { text: `${fits}y` })).toBe(false);
    ws.open();

    expect(texts(ws.sentFrames())).toEqual([fits]);
  });

  it('does not reject a pending stream that has the same streamId', async () => {
    const { socket } = build();
    let firstSettled = false;
    const first = socket.stream('ask-ai', { prompt: 'hi' }, { streamId: 'reply-1' });
    first.then(
      () => (firstSettled = true),
      () => (firstSettled = true),
    );

    await expect(
      socket.stream('ask-ai', { prompt: big }, { streamId: 'reply-1' }),
    ).rejects.toMatchObject({ code: 'dropped' });
    await Promise.resolve();

    expect(firstSettled).toBe(false);
  });

  it('is sent as normal when the socket is open and the queue is empty', () => {
    const { socket, ws } = build();
    ws.open();

    expect(socket.send('send-message', { text: big })).toBe(true);
    expect(texts(ws.sentFrames())).toEqual([big]);
  });

  it('is refused, not sent ahead, while a staggered flush is still sending the queue', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(100);

    socket.send('send-message', { text: 'a' });
    socket.send('send-message', { text: 'b' });
    ws.open();

    expect(socket.send('send-message', { text: big })).toBe(false);
    vi.advanceTimersByTime(300);

    expect(texts(ws.sentFrames())).toEqual(['a', 'b']);
  });
});
