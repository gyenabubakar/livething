import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { MessageBuffer } from '~/primitives/buffering/buffer.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '~/internal/runtime.ts';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { SocketContract } from '~/types.ts';

interface C extends SocketContract {
  outgoing: { typing: { channelId: string } };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function buildSocket<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<C, P>
) {
  return client<C>()(connect('wss://test'), ...primitives);
}

/** A stub owner: pending until rejected, capturing the reason it was rejected with. */
function makeOwner(): {
  owner: { isPending(): boolean; reject(e: unknown): void };
  reason(): unknown;
} {
  let pending = true;
  let captured: unknown;
  return {
    owner: {
      isPending: () => pending,
      reject: (error) => {
        pending = false;
        captured = error;
      },
    },
    reason: () => captured,
  };
}

describe('MessageBuffer — owner settling', () => {
  it('rejects the evicted owner when the ring overflows', () => {
    const buffer = new MessageBuffer({ maxSize: 1 });
    const first = makeOwner();
    const second = makeOwner();

    buffer.enqueue({ event: 'a', payload: 1 }, undefined, first.owner);
    buffer.enqueue({ event: 'b', payload: 2 }, undefined, second.owner);

    expect(first.owner.isPending()).toBe(false);
    expect((first.reason() as { code?: string }).code).toBe('dropped');
    expect(second.owner.isPending()).toBe(true);
  });

  it('rejects an owner whose frame expires before flush', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({});
    const expiring = makeOwner();
    const fresh = makeOwner();

    buffer.enqueue({ event: 'typing', payload: {} }, 200, expiring.owner);
    buffer.enqueue({ event: 'keep', payload: {} }, undefined, fresh.owner);

    vi.advanceTimersByTime(300);
    buffer.flush(vi.fn());

    expect(expiring.owner.isPending()).toBe(false);
    expect((expiring.reason() as { code?: string }).code).toBe('dropped');
    expect(fresh.owner.isPending()).toBe(true);
  });

  it('rejects all pending owners on clear', () => {
    const buffer = new MessageBuffer({ maxSize: 5 });
    const one = makeOwner();
    const two = makeOwner();
    buffer.enqueue({ event: 'a', payload: 1 }, undefined, one.owner);
    buffer.enqueue({ event: 'b', payload: 2 }, undefined, two.owner);

    buffer.clear();

    expect(one.owner.isPending()).toBe(false);
    expect(two.owner.isPending()).toBe(false);
    expect((one.reason() as { code?: string }).code).toBe('disconnected');
  });

  it('skips a frame whose owner already settled and sends the rest', () => {
    const buffer = new MessageBuffer({ maxSize: 5 });
    const settled = makeOwner();
    const live = makeOwner();
    buffer.enqueue({ event: 'gone', payload: 1 }, undefined, settled.owner);
    buffer.enqueue({ event: 'live', payload: 2 }, undefined, live.owner);

    settled.owner.reject(new Error('timed out'));

    const sent: string[] = [];
    buffer.flush((m) => sent.push(m.event));

    expect(sent).toEqual(['live']);
  });

  it('rejects the exact owner and reports when its frame fails to serialize on flush, later frames still flush', () => {
    const buffer = new MessageBuffer({ maxSize: 5 });
    const bad = makeOwner();
    const good = makeOwner();
    buffer.enqueue({ event: 'bad', payload: 1 }, undefined, bad.owner);
    buffer.enqueue({ event: 'good', payload: 2 }, undefined, good.owner);

    const typeError = new TypeError('circular');
    const onError = vi.fn();
    const sent: string[] = [];
    buffer.flush((m) => {
      if (m.event === 'bad') throw typeError;

      sent.push(m.event);
    }, onError);

    expect(bad.owner.isPending()).toBe(false);
    expect(bad.reason()).toBe(typeError);
    expect(onError).toHaveBeenCalledWith(typeError);
    expect(sent).toEqual(['good']);
    expect(good.owner.isPending()).toBe(true);
  });

  it('an ownerless send still flushes normally', () => {
    const buffer = new MessageBuffer({ maxSize: 5 });
    buffer.enqueue({ event: 'plain', payload: 1 });

    const sent: string[] = [];
    buffer.flush((m) => sent.push(m.event));
    expect(sent).toEqual(['plain']);
  });
});

describe('MessageBuffer — maxSize validation', () => {
  it('throws on maxSize of 0 instead of silently accepting nothing', () => {
    expect(() => new MessageBuffer({ maxSize: 0 })).toThrow(/positive integer/);
  });

  it('throws on a negative or non-integer maxSize', () => {
    expect(() => new MessageBuffer({ maxSize: -1 })).toThrow(/positive integer/);
    expect(() => new MessageBuffer({ maxSize: 2.5 })).toThrow(/positive integer/);
  });

  it('still accepts a valid maxSize', () => {
    const buffer = new MessageBuffer({ maxSize: 1 });
    expect(buffer.enqueue({ event: 'a', payload: 1 })).toBe(true);
  });
});

describe('MessageBuffer — ring overflow (drop-oldest)', () => {
  it('caps at maxSize and drops the oldest when the ring overflows', () => {
    const buffer = new MessageBuffer({ maxSize: 3 });
    const send = vi.fn();

    buffer.enqueue({ event: 'a', payload: 1 });
    buffer.enqueue({ event: 'b', payload: 2 });
    buffer.enqueue({ event: 'c', payload: 3 });
    buffer.enqueue({ event: 'd', payload: 4 });

    buffer.flush(send);

    const events = send.mock.calls.map((c) => c[0].event);
    expect(events).toEqual(['b', 'c', 'd']);
    expect(events).not.toContain('a');
  });

  it('preserves order across multiple overflows', () => {
    const buffer = new MessageBuffer({ maxSize: 2 });
    const send = vi.fn();

    buffer.enqueue({ event: 'a', payload: 1 });
    buffer.enqueue({ event: 'b', payload: 2 });
    buffer.enqueue({ event: 'c', payload: 3 });
    buffer.enqueue({ event: 'd', payload: 4 });

    buffer.flush(send);

    const events = send.mock.calls.map((c) => c[0].event);
    expect(events).toEqual(['c', 'd']);
  });
});

describe('MessageBuffer — flush isolation', () => {
  it('drains the rest and reports when one send throws', () => {
    const buffer = new MessageBuffer({ maxSize: 5 });
    buffer.enqueue({ event: 'bad', payload: 1 });
    buffer.enqueue({ event: 'good', payload: 2 });

    const onError = vi.fn();
    const sent: string[] = [];
    function send(m: Message): void {
      if (m.event === 'bad') throw new Error('serialize failed');

      sent.push(m.event);
    }

    buffer.flush(send, onError);

    expect(sent).toEqual(['good']);
    expect(onError).toHaveBeenCalledTimes(1);

    const resend = vi.fn();
    buffer.flush(resend);
    expect(resend).not.toHaveBeenCalled();
  });
});

describe('MessageBuffer — TTL expiry on flush', () => {
  it('drops messages whose TTL elapsed and sends the ones still fresh', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({});
    const send = vi.fn();

    buffer.enqueue({ event: 'typing', payload: {} }, 500);
    buffer.enqueue({ event: 'mark-read', payload: {} });

    vi.advanceTimersByTime(600);

    buffer.flush(send);

    const events = send.mock.calls.map((c) => c[0].event);
    expect(events).not.toContain('typing');
    expect(events).toContain('mark-read');
  });

  it('a per-call TTL beats the buffer-wide TTL', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ ttl: 1000 });
    const send = vi.fn();

    buffer.enqueue({ event: 'typing', payload: {} }, 200);

    vi.advanceTimersByTime(300);

    buffer.flush(send);
    expect(send).not.toHaveBeenCalled();
  });

  it('applies the buffer-wide TTL to every message without a per-call TTL', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ ttl: 500 });
    const send = vi.fn();

    buffer.enqueue({ event: 'typing', payload: {} });
    buffer.enqueue({ event: 'mark-read', payload: {} });
    buffer.enqueue({ event: 'pinned', payload: {} }, 10_000);

    vi.advanceTimersByTime(600);

    buffer.flush(send);
    const events = send.mock.calls.map((c) => c[0].event);
    expect(events).toEqual(['pinned']);
  });

  it('logs one debug line for a buffered send, as the debug logging docs show', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const socket = buildSocket(buffering());
    socket.setDebug(true);

    socket.send('typing', { channelId: 'x' });

    const lines = log.mock.calls.map((call) => call.join(' ')).filter((l) => l.includes('typing'));
    log.mockRestore();
    expect(lines).toEqual(["[livething] buffered 'typing'"]);
  });

  it('ttl option on buffering() primitive is respected end-to-end', () => {
    vi.useFakeTimers();

    const socket = buildSocket(buffering({ ttl: 300 }));

    expect(socket.send('typing', { channelId: 'x' })).toBe(true);

    vi.advanceTimersByTime(400);

    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const frames = ws.sentFrames();
    expect(frames.some((f) => f.event === 'typing')).toBe(false);
  });
});

describe('MessageBuffer — staggered flushInterval tick loop', () => {
  it('sends one message per flushInterval tick and stops flushing when done', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ flushInterval: 100 });
    const send = vi.fn();

    buffer.enqueue({ event: 'a', payload: 1 });
    buffer.enqueue({ event: 'b', payload: 2 });
    buffer.enqueue({ event: 'c', payload: 3 });

    buffer.flush(send);

    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(3);
    expect(buffer.isFlushing).toBe(false);
  });

  it('clears the in-progress flush timer when clear() is called mid-flush', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ flushInterval: 100 });
    const send = vi.fn();

    buffer.enqueue({ event: 'a', payload: 1 });
    buffer.enqueue({ event: 'b', payload: 2 });

    buffer.flush(send);

    expect(send).toHaveBeenCalledTimes(1);

    buffer.clear();

    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps unsent messages when stopped mid-flush, instead of losing them', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ flushInterval: 100 });
    const delivered: string[] = [];
    let wireOpen = true;
    function send(m: Message): void {
      if (wireOpen) delivered.push(m.event);
    }

    buffer.enqueue({ event: 'm1', payload: {} });
    buffer.enqueue({ event: 'm2', payload: {} });
    buffer.enqueue({ event: 'm3', payload: {} });

    buffer.flush(send);
    expect(delivered).toEqual(['m1']);

    wireOpen = false;
    buffer.stopFlush();
    vi.advanceTimersByTime(500);
    expect(delivered).toEqual(['m1']);

    wireOpen = true;
    buffer.flush(send);
    expect(delivered).toEqual(['m1', 'm2']);
    vi.advanceTimersByTime(100);
    expect(delivered).toEqual(['m1', 'm2', 'm3']);
  });

  it('does not start a flush timer when every message has expired', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ flushInterval: 100 });
    const send = vi.fn();

    buffer.enqueue({ event: 'typing', payload: {} }, 100);
    vi.advanceTimersByTime(200);

    buffer.flush(send);

    expect(send).not.toHaveBeenCalled();
    expect(buffer.isFlushing).toBe(false);
  });
});

describe('buffering — a send after a staggered flush empties the buffer', () => {
  it('goes straight out, without waiting one more interval', () => {
    vi.useFakeTimers();
    const socket = buildSocket(buffering({ flushInterval: 100 }));
    socket.connect();
    const ws = MockWebSocket.last();

    socket.send('typing', { channelId: 'a' });
    socket.send('typing', { channelId: 'b' });
    ws.open();
    vi.advanceTimersByTime(100);
    expect(ws.sentFrames()).toHaveLength(2);

    socket.send('typing', { channelId: 'c' });

    expect(ws.sentFrames()).toHaveLength(3);
  });

  it('still queues a send behind messages that have not gone out', () => {
    vi.useFakeTimers();
    const socket = buildSocket(buffering({ flushInterval: 100 }));
    socket.connect();
    const ws = MockWebSocket.last();

    socket.send('typing', { channelId: 'a' });
    socket.send('typing', { channelId: 'b' });
    ws.open();
    socket.send('typing', { channelId: 'c' });
    expect(ws.sentFrames()).toHaveLength(1);

    vi.advanceTimersByTime(200);

    expect(ws.sentFrames().map((frame) => frame.payload.channelId)).toEqual(['a', 'b', 'c']);
  });
});

describe('MessageBuffer — double flush', () => {
  it('a second flush before the first timer fires sends each message exactly once', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ flushInterval: 100 });
    const send = vi.fn();

    buffer.enqueue({ event: 'a', payload: 1 });
    buffer.enqueue({ event: 'b', payload: 2 });

    buffer.flush(send);
    expect(send).toHaveBeenCalledTimes(1);

    buffer.flush(send);

    vi.runAllTimers();

    expect(send.mock.calls.map((c) => c[0].event)).toEqual(['a', 'b']);
  });
});

describe('MessageBuffer — TTL zero means no expiry', () => {
  it('message with ttl=0 is sent (ttl=0 means no expiry, not instant-drop)', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({});
    const send = vi.fn();

    buffer.enqueue({ event: 'ping', payload: {} }, 0);

    buffer.flush(send);

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('buffering — live send during a staggered flush stays in order', () => {
  it('queues a send made mid-flush behind the not-yet-flushed messages', () => {
    vi.useFakeTimers();
    const socket = buildSocket(buffering({ flushInterval: 100 }));
    socket.connect();
    let ws = MockWebSocket.last();
    ws.open();

    ws.serverClose(1006);

    socket.send('typing', { channelId: 'a' });
    socket.send('typing', { channelId: 'b' });

    socket.connect();
    ws = MockWebSocket.last();
    ws.open();

    // A live send while the flush is still draining must NOT jump ahead of 'b'.
    socket.send('typing', { channelId: 'c' });

    vi.advanceTimersByTime(300);
    const order = ws
      .sentFrames()
      .map((f: Message) => (f.payload as { channelId: string }).channelId);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
