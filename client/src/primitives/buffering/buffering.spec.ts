import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { MessageBuffer } from '~/primitives/buffering/buffer.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WireMessage } from '~/internal/runtime.ts';
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

describe('MessageBuffer — ring overflow (drop-oldest)', () => {
  it('caps at maxSize and drops the oldest when the ring overflows', () => {
    const buffer = new MessageBuffer({ enabled: true, maxSize: 3 });
    const send = vi.fn();

    buffer.enqueue({ event: 'a', payload: 1 });
    buffer.enqueue({ event: 'b', payload: 2 });
    buffer.enqueue({ event: 'c', payload: 3 });
    // Overflow: oldest ('a') is dropped
    buffer.enqueue({ event: 'd', payload: 4 });

    expect(buffer.size).toBe(3);
    buffer.flush(send);

    const events = send.mock.calls.map((c) => c[0].event);
    expect(events).toEqual(['b', 'c', 'd']);
    expect(events).not.toContain('a');
  });

  it('preserves order across multiple overflows', () => {
    const buffer = new MessageBuffer({ enabled: true, maxSize: 2 });
    const send = vi.fn();

    buffer.enqueue({ event: 'a', payload: 1 });
    buffer.enqueue({ event: 'b', payload: 2 });
    buffer.enqueue({ event: 'c', payload: 3 }); // drops 'a'
    buffer.enqueue({ event: 'd', payload: 4 }); // drops 'b'

    expect(buffer.size).toBe(2);
    buffer.flush(send);

    const events = send.mock.calls.map((c) => c[0].event);
    expect(events).toEqual(['c', 'd']);
  });
});

describe('MessageBuffer — TTL expiry on flush', () => {
  it('drops messages whose TTL elapsed and sends the ones still fresh', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ enabled: true });
    const send = vi.fn();

    // Enqueue two messages — one expires in 500 ms, one has no TTL
    buffer.enqueue({ event: 'typing', payload: {} }, 500);
    buffer.enqueue({ event: 'mark-read', payload: {} });

    vi.advanceTimersByTime(600);

    buffer.flush(send);

    const events = send.mock.calls.map((c) => c[0].event);
    expect(events).not.toContain('typing');
    expect(events).toContain('mark-read');
  });

  it('resolveTTL picks per-call TTL over per-event map', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ enabled: true, ttl: { typing: 1000 } });
    const send = vi.fn();

    // Per-call TTL of 200 ms wins over the per-event 1000 ms
    buffer.enqueue({ event: 'typing', payload: {} }, 200);

    vi.advanceTimersByTime(300);

    buffer.flush(send);
    expect(send).not.toHaveBeenCalled();
  });

  it('resolveTTL uses per-event map when no per-call TTL is given', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ enabled: true, ttl: { typing: 500 } });
    const send = vi.fn();

    buffer.enqueue({ event: 'typing', payload: {} }); // picks 500 ms from map
    buffer.enqueue({ event: 'other', payload: {} }); // no TTL in map → never expires

    vi.advanceTimersByTime(600);

    buffer.flush(send);
    const events = send.mock.calls.map((c) => c[0].event);
    expect(events).not.toContain('typing');
    expect(events).toContain('other');
  });

  it('ttl option on buffering() primitive is respected end-to-end', () => {
    vi.useFakeTimers();

    const socket = buildSocket(buffering({ enabled: true, ttl: { typing: 300 } }));

    // Send while disconnected — gets buffered with a 300 ms TTL for 'typing'
    expect(socket.send('typing', { channelId: 'x' })).toBe(true);

    vi.advanceTimersByTime(400);

    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    // The typing message should have been dropped (TTL elapsed)
    const frames = ws.sentFrames();
    expect(frames.some((f) => f.event === 'typing')).toBe(false);
  });
});

describe('MessageBuffer — staggered flushInterval tick loop', () => {
  it('sends one message per flushInterval tick and calls onComplete when done', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ enabled: true, flushInterval: 100 });
    const send = vi.fn();
    const onComplete = vi.fn();

    buffer.enqueue({ event: 'a', payload: 1 });
    buffer.enqueue({ event: 'b', payload: 2 });
    buffer.enqueue({ event: 'c', payload: 3 });

    buffer.flush(send, onComplete);

    // First message goes out immediately on the first tick()
    expect(send).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onComplete).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(100);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('clears the in-progress flush timer when clear() is called mid-flush', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ enabled: true, flushInterval: 100 });
    const send = vi.fn();

    buffer.enqueue({ event: 'a', payload: 1 });
    buffer.enqueue({ event: 'b', payload: 2 });

    buffer.flush(send);

    expect(send).toHaveBeenCalledTimes(1); // first tick fires immediately

    buffer.clear(); // must cancel the pending timer

    vi.advanceTimersByTime(500); // no further ticks should fire
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps unsent messages when stopped mid-flush, instead of losing them', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ enabled: true, flushInterval: 100 });
    const delivered: string[] = [];
    let wireOpen = true;
    function send(m: WireMessage): void {
      if (wireOpen) delivered.push(m.event);
    }

    buffer.enqueue({ event: 'm1', payload: {} });
    buffer.enqueue({ event: 'm2', payload: {} });
    buffer.enqueue({ event: 'm3', payload: {} });

    buffer.flush(send); // m1 goes out immediately
    expect(delivered).toEqual(['m1']);

    // Socket drops mid-flush: stop the drip and confirm m2/m3 stay buffered.
    wireOpen = false;
    buffer.stopFlush();
    vi.advanceTimersByTime(500); // no further ticks
    expect(delivered).toEqual(['m1']);
    expect(buffer.size).toBe(2);

    // On reconnect they flush successfully.
    wireOpen = true;
    buffer.flush(send);
    expect(delivered).toEqual(['m1', 'm2']); // m2 immediate
    vi.advanceTimersByTime(100);
    expect(delivered).toEqual(['m1', 'm2', 'm3']);
  });

  it('onComplete fires even when all messages are expired (zero valid)', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ enabled: true, flushInterval: 100 });
    const onComplete = vi.fn();
    const send = vi.fn();

    buffer.enqueue({ event: 'typing', payload: {} }, 100);
    vi.advanceTimersByTime(200);

    buffer.flush(send, onComplete);

    expect(send).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('MessageBuffer — double-flush / onComplete guard', () => {
  it('[BUG buffer-double-complete] second flush before first timer fires calls onComplete exactly once', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ enabled: true, flushInterval: 100 });
    const send = vi.fn();
    const onComplete = vi.fn();

    buffer.enqueue({ event: 'a', payload: 1 });
    buffer.enqueue({ event: 'b', payload: 2 });

    // First flush: 'a' goes out immediately, timer pending for 'b'
    buffer.flush(send, onComplete);
    expect(send).toHaveBeenCalledTimes(1);

    // Second flush before the first timer fires — should take over
    buffer.flush(send, onComplete);

    // Advance past all possible timers
    vi.runAllTimers();

    // onComplete should fire exactly once (from the second flush completing)
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('MessageBuffer — TTL zero means no expiry', () => {
  it('[BUG ttl-zero] message with ttl=0 is sent (ttl=0 means no expiry, not instant-drop)', () => {
    vi.useFakeTimers();
    const buffer = new MessageBuffer({ enabled: true });
    const send = vi.fn();

    // ttl=0 should mean "no expiry" — message must be flushed
    buffer.enqueue({ event: 'ping', payload: {} }, 0);

    buffer.flush(send);

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('buffering disabled — outgoing fallback returns false', () => {
  it('send() returns false while disconnected when buffering is not enabled', () => {
    const socket = buildSocket(buffering({ enabled: false }));
    // Socket is not yet connected — disabled buffer must NOT queue the message
    expect(socket.send('typing', { channelId: 'a' })).toBe(false);
  });

  it('send() returns false with default options (enabled defaults to false)', () => {
    const socket = buildSocket(buffering());
    expect(socket.send('typing', { channelId: 'a' })).toBe(false);
  });

  it('nothing is replayed on reconnect when buffering is disabled', () => {
    const socket = buildSocket(buffering({ enabled: false }));
    socket.send('typing', { channelId: 'a' });

    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const frames = ws.sentFrames();
    expect(frames.some((f) => f.event === 'typing')).toBe(false);
  });

  it('MessageBuffer.enqueue returns false when not enabled', () => {
    const buffer = new MessageBuffer({ enabled: false });
    const result = buffer.enqueue({ event: 'typing', payload: {} });
    expect(result).toBe(false);
    expect(buffer.size).toBe(0);
  });
});

describe('buffering — live send during a staggered flush stays in order', () => {
  it('queues a send made mid-flush behind the not-yet-flushed messages', () => {
    vi.useFakeTimers();
    const socket = buildSocket(buffering({ enabled: true, flushInterval: 100 }));
    socket.connect();
    let ws = MockWebSocket.last();
    ws.open();
    ws.serverClose(1006); // offline; the buffer keeps queued sends

    socket.send('typing', { channelId: 'a' });
    socket.send('typing', { channelId: 'b' });

    socket.connect();
    ws = MockWebSocket.last();
    ws.open(); // onOpen flush: 'a' goes now, 'b' scheduled +100ms

    // A live send while the flush is still draining must NOT jump ahead of 'b'.
    socket.send('typing', { channelId: 'c' });

    vi.advanceTimersByTime(300);
    const order = ws
      .sentFrames()
      .map((f: WireMessage) => (f.payload as { channelId: string }).channelId);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
