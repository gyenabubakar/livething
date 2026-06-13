import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { ack } from '~/primitives/ack/index.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// request(), sendWithAck() and stream() all "send and await". They must obey the
// same rule as send(): with buffering on, a frame queued offline (or while a
// staggered flush is draining) flushes in order; with buffering off, a frame sent
// before the socket opens is held for the in-progress connect and flushed on open
// (it is NOT raced onto the wire ahead of buffered messages, and NOT dropped).
interface C {
  outgoing: { typing: { id: string } };
  requests: { echo: { payload: { id: string }; response: { ok: boolean } } };
  streams: {
    feed: { payload: { id: string }; chunk: { text: string }; kind: 'ephemeral'; nudges: never };
  };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('send-and-await frames respect the buffering flush order', () => {
  it('a request fired during a staggered flush lands behind the not-yet-flushed messages', () => {
    vi.useFakeTimers();
    const socket = client<C>()(
      connect('wss://test'),
      buffering({ enabled: true, flushInterval: 100 }),
      requestResponse(),
    );
    socket.connect();
    let ws = MockWebSocket.last();
    ws.open();
    ws.serverClose(1006); // offline; the buffer keeps queued sends

    socket.send('typing', { id: 'a' });
    socket.send('typing', { id: 'b' });

    socket.connect();
    ws = MockWebSocket.last();
    ws.open(); // onOpen flush: 'a' now, 'b' scheduled +100ms (isFlushing = true)

    void socket.request('echo', { id: 'r' }); // must NOT jump ahead of 'b'

    vi.advanceTimersByTime(300);
    const order = ws
      .sentFrames()
      .map((f: { event: string }) => f.event)
      .filter((e: string) => e === 'typing' || e === 'echo');
    expect(order).toEqual(['typing', 'typing', 'echo']);
  });

  it('a stream trigger fired during a staggered flush lands behind the not-yet-flushed messages', () => {
    vi.useFakeTimers();
    const socket = client<C>()(
      connect('wss://test'),
      buffering({ enabled: true, flushInterval: 100 }),
      stream(),
    );
    socket.connect();
    let ws = MockWebSocket.last();
    ws.open();
    ws.serverClose(1006);

    socket.send('typing', { id: 'a' });
    socket.send('typing', { id: 'b' });

    socket.connect();
    ws = MockWebSocket.last();
    ws.open();

    void socket.stream('feed', { id: 's' }); // must NOT jump ahead of 'b'

    vi.advanceTimersByTime(300);
    const order = ws
      .sentFrames()
      .map((f: { event: string }) => f.event)
      .filter((e: string) => e === 'typing' || e === 'feed');
    expect(order).toEqual(['typing', 'typing', 'feed']);
  });
});

describe('send-and-await frames are held (not dropped) before open without buffering', () => {
  it('holds a sendWithAck made before open and flushes it when the socket opens', async () => {
    const socket = client<C>()(connect('wss://test', { lazy: true }), ack());
    const pending = socket.sendWithAck('typing', { id: 'a' }); // lazy connect; not open yet
    void pending.catch(() => undefined);

    const ws = MockWebSocket.last(); // created by the lazy connect
    expect(ws.sentFrames()).toEqual([]); // held — not sent, not rejected

    ws.open(); // onOpen flushes the held frame
    const sent = ws.sentFrames().find((f: { event: string }) => f.event === 'typing');
    expect(sent).toBeDefined();

    const ackId = sent.__wskit.ackId as string;
    ws.emit({ event: 'typing', payload: {}, __wskit: { ackId } }); // server confirms
    await expect(pending).resolves.toBeUndefined();
  });

  it('holds a request made before open and flushes it when the socket opens', async () => {
    const socket = client<C>()(connect('wss://test', { lazy: true }), requestResponse());
    const pending = socket.request('echo', { id: 'r' });
    void pending.catch(() => undefined);

    const ws = MockWebSocket.last();
    expect(ws.sentFrames()).toEqual([]); // held

    ws.open();
    const sent = ws.sentFrames().find((f: { event: string }) => f.event === 'echo');
    expect(sent).toBeDefined();

    const correlationId = sent.__wskit.correlationId as string;
    ws.emit({ event: 'echo', payload: { ok: true }, __wskit: { correlationId } });
    await expect(pending).resolves.toEqual({ ok: true });
  });
});

describe('send-and-await frames fail fast on a closed socket (no buffering)', () => {
  // A non-lazy socket that was never connected sits in 'closed' and is not heading
  // anywhere; the held frame would never flush, so these must reject promptly with
  // 'disconnected' rather than hang until their own timeout fires.
  it('sendWithAck rejects with disconnected without waiting for the ack timeout', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), ack({ timeout: 10_000 }));
      const settled = vi.fn();
      socket.sendWithAck('typing', { id: 'a' }).then(
        () => settled('resolved'),
        (e: { code?: string }) => settled(e?.code),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toHaveBeenCalledWith('disconnected'); // settled with the 10s timer un-advanced
    } finally {
      vi.useRealTimers();
    }
  });

  it('request rejects with disconnected without waiting for the request timeout', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), requestResponse({ timeout: 10_000 }));
      const settled = vi.fn();
      socket.request('echo', { id: 'r' }).then(
        () => settled('resolved'),
        (e: { code?: string }) => settled(e?.code),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toHaveBeenCalledWith('disconnected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stream() rejects with disconnected without waiting for the trigger timeout', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream({ timeout: 10_000 }));
      const settled = vi.fn();
      socket.stream('feed', { id: 's' }).then(
        () => settled('resolved'),
        (e: { code?: string }) => settled(e?.code),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toHaveBeenCalledWith('disconnected');
    } finally {
      vi.useRealTimers();
    }
  });
});
