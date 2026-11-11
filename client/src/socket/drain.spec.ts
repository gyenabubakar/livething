import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
  vi.useFakeTimers();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

function openSocket() {
  const socket = client()(connect('wss://test'));
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

describe('socket.drain()', () => {
  it('resolves at once when the buffer is below 256 KiB', async () => {
    const { socket, ws } = openSocket();
    ws.bufferedAmount = 256 * 1024 - 1;

    expect(await settled(socket.drain())).toBe(true);
  });

  it('resolves at once when the socket is not open', async () => {
    const socket = client()(connect('wss://test'));

    expect(await settled(socket.drain())).toBe(true);
  });

  it('waits while the buffer is at 256 KiB or more, and resolves when it goes down', async () => {
    const { socket, ws } = openSocket();
    ws.bufferedAmount = 256 * 1024;
    const drained = socket.drain();

    expect(await settled(drained)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled(drained)).toBe(false);

    ws.bufferedAmount = 10;
    await vi.advanceTimersByTimeAsync(30);
    expect(await settled(drained)).toBe(true);
  });

  it('checks the buffer every 25 ms', async () => {
    const { socket, ws } = openSocket();
    ws.bufferedAmount = 256 * 1024;
    const drained = socket.drain();
    await vi.advanceTimersByTimeAsync(0);

    ws.bufferedAmount = 10;
    await vi.advanceTimersByTimeAsync(24);
    expect(await settled(drained)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(drained)).toBe(true);
  });

  it('resolves when the socket closes while it waits', async () => {
    const { socket, ws } = openSocket();
    ws.bufferedAmount = 1024 * 1024;
    const drained = socket.drain();

    socket.disconnect();
    await vi.advanceTimersByTimeAsync(30);

    expect(await settled(drained)).toBe(true);
    expect(ws.readyState).toBe(3);
  });

  it('stops waiting after about 50 seconds and resolves', async () => {
    const { socket, ws } = openSocket();
    ws.bufferedAmount = 1024 * 1024;
    const drained = socket.drain();

    await vi.advanceTimersByTimeAsync(49_000);
    expect(await settled(drained)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await settled(drained)).toBe(true);
  });
});
