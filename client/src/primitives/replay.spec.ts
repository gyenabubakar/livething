import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { dedup } from '~/primitives/dedup.ts';
import { gaps } from '~/primitives/gaps.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { replay } from '~/primitives/replay.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  incoming: { msg: { text: string } };
  outgoing: { chat: { text: string } };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function build<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<C, P>
) {
  const socket = client<C>()(connect('wss://test'), ...primitives);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

function reconnectAfterDrop(ws: MockWebSocket): MockWebSocket {
  ws.serverClose(1006, 'dropped');
  vi.advanceTimersByTime(1500);
  const next = MockWebSocket.last();
  next.open();

  return next;
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  restore();
});

describe('replay — resume tokens', () => {
  it('shows the tokens of earlier connections in the catch-up request', () => {
    const { ws } = build(dedup(), gaps(), replay(), reconnection());
    ws.emit({ event: '__resume__', payload: { token: 'first' }, metadata: null });
    ws.emit({ event: 'msg', payload: { text: 'hi' }, metadata: { delivery: { seq: 3 } } });

    const second = reconnectAfterDrop(ws);
    expect(second.sentFrames()).toContainEqual({
      event: '__replay__',
      payload: { lastKnownSeq: 3, resume: ['first'] },
      metadata: null,
    });

    second.emit({ event: '__resume__', payload: { token: 'second' }, metadata: null });
    const third = reconnectAfterDrop(second);
    expect(third.sentFrames()).toContainEqual({
      event: '__replay__',
      payload: { lastKnownSeq: 3, resume: ['first', 'second'] },
      metadata: null,
    });
  });

  it('starts the top-level cursor at the resume frame seq when no message came before the drop', () => {
    const { ws } = build(dedup(), gaps(), replay(), reconnection());
    ws.emit({ event: '__resume__', payload: { token: 'first', seq: 5 }, metadata: null });

    const second = reconnectAfterDrop(ws);
    expect(second.sentFrames()).toContainEqual({
      event: '__replay__',
      payload: { lastKnownSeq: 5, resume: ['first'] },
      metadata: null,
    });
  });

  it('never moves the cursor forward to a later resume frame seq', () => {
    const { ws } = build(dedup(), gaps(), replay(), reconnection());
    ws.emit({ event: '__resume__', payload: { token: 'first', seq: 2 }, metadata: null });
    ws.emit({ event: 'msg', payload: { text: 'hi' }, metadata: { delivery: { seq: 3 } } });

    const second = reconnectAfterDrop(ws);
    second.emit({ event: '__resume__', payload: { token: 'second', seq: 9 }, metadata: null });
    const third = reconnectAfterDrop(second);
    expect(third.sentFrames()).toContainEqual({
      event: '__replay__',
      payload: { lastKnownSeq: 3, resume: ['first', 'second'] },
      metadata: null,
    });
  });

  it('keeps only the last eight tokens', () => {
    const { ws } = build(dedup(), gaps(), replay(), reconnection());
    for (let i = 1; i <= 10; i += 1) {
      ws.emit({ event: '__resume__', payload: { token: `t${i}` }, metadata: null });
    }

    ws.emit({ event: 'msg', payload: { text: 'hi' }, metadata: { delivery: { seq: 3 } } });

    const second = reconnectAfterDrop(ws);
    const request = second.sentFrames().find((frame) => frame.event === '__replay__');
    expect((request?.payload as { resume?: string[] } | undefined)?.resume).toEqual([
      't3',
      't4',
      't5',
      't6',
      't7',
      't8',
      't9',
      't10',
    ]);
  });
});

describe('replay — per-channel scope catch-up', () => {
  it('catches up a channel that got no message before the drop, from its subscribe seq', () => {
    const { ws } = build(dedup(), replay(), reconnection());
    ws.emit({
      event: '__subscribeOk__',
      payload: { seq: 7 },
      metadata: { channel: { name: 'lobby', family: 'rooms' } },
    });

    const next = reconnectAfterDrop(ws);

    expect(next.sentFrames()).toContainEqual({
      event: '__replay__',
      payload: { lastKnownSeq: 7 },
      metadata: { channel: { name: 'lobby', family: 'rooms' } },
    });
  });

  it('never moves a channel cursor forward to a later subscribe seq', () => {
    const { ws } = build(dedup(), replay(), reconnection());
    const channel = { name: 'lobby' };
    ws.emit({ event: 'msg', payload: { text: 'hi' }, metadata: { channel, delivery: { seq: 3 } } });
    ws.emit({ event: '__subscribeOk__', payload: { seq: 9 }, metadata: { channel } });

    const next = reconnectAfterDrop(ws);

    expect(next.sentFrames()).toContainEqual({
      event: '__replay__',
      payload: { lastKnownSeq: 3 },
      metadata: { channel },
    });
  });

  describe('channel-scoped seq tracking', () => {
    it('tracks seq under the channel name, not the top-level key', () => {
      const { ws } = build(dedup(), gaps(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'hi' },
        metadata: { channel: { name: 'room-a' }, delivery: { seq: 3 } },
      });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      expect(frames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 3 },
        metadata: { channel: { name: 'room-a' } },
      });
    });

    it('uses null metadata for a top-level catch-up request', () => {
      const { ws } = build(dedup(), gaps(), replay(), reconnection());

      ws.emit({ event: 'msg', payload: { text: 'hi' }, metadata: { delivery: { seq: 3 } } });

      const second = reconnectAfterDrop(ws);
      expect(second.sentFrames()).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 3 },
        metadata: null,
      });
    });

    it('does not emit a top-level __replay__ when only channel-scoped messages were seen', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'hi' },
        metadata: { channel: { name: 'room-a' }, delivery: { seq: 7 } },
      });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      const topLevelReplay = frames.find(
        (f: { event: string; metadata?: unknown }) =>
          f.event === '__replay__' && f.metadata === undefined,
      );
      expect(topLevelReplay).toBeUndefined();
    });

    it('tracks two channels that share a name in different scopes separately', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'a' },
        metadata: { channel: { name: 'lobby', family: 'rooms' }, delivery: { seq: 5 } },
      });
      ws.emit({
        event: 'msg',
        payload: { text: 'b' },
        metadata: { channel: { name: 'lobby', family: 'tenants' }, delivery: { seq: 9 } },
      });

      const second = reconnectAfterDrop(ws);
      const replayFrames = second.sentFrames().filter((f) => f.event === '__replay__');

      // Each scope must get its own catch-up — they must not collapse into one.
      expect(replayFrames).toHaveLength(2);
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 5 },
        metadata: { channel: { name: 'lobby', family: 'rooms' } },
      });
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 9 },
        metadata: { channel: { name: 'lobby', family: 'tenants' } },
      });
    });
  });

  describe('channelFamily included in catch-up request', () => {
    it('attaches channelFamily to the __replay__ frame when the message had one', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'scoped' },
        metadata: { channel: { name: 'room-b', family: 'tenant-1' }, delivery: { seq: 10 } },
      });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      expect(frames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 10 },
        metadata: { channel: { name: 'room-b', family: 'tenant-1' } },
      });
    });

    it('omits channelFamily from the frame when the original message had none', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'plain' },
        metadata: { channel: { name: 'room-c' }, delivery: { seq: 2 } },
      });

      const second = reconnectAfterDrop(ws);
      const replayFrame = second
        .sentFrames()
        .find((f: { event: string }) => f.event === '__replay__');

      expect(replayFrame).toBeDefined();
      expect(replayFrame.metadata).not.toHaveProperty('channelFamily');
    });
  });

  describe('distinct channels each get their own catch-up request', () => {
    it('produces one __replay__ per channel when two distinct channels received messages', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'a' },
        metadata: { channel: { name: 'alpha' }, delivery: { seq: 1 } },
      });
      ws.emit({
        event: 'msg',
        payload: { text: 'b' },
        metadata: { channel: { name: 'beta' }, delivery: { seq: 9 } },
      });

      const second = reconnectAfterDrop(ws);
      const replayFrames = second
        .sentFrames()
        .filter((f: { event: string }) => f.event === '__replay__');

      expect(replayFrames).toHaveLength(2);

      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 1 },
        metadata: { channel: { name: 'alpha' } },
      });
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 9 },
        metadata: { channel: { name: 'beta' } },
      });
    });

    it('tracks top-level and channel-scoped seqs independently', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({ event: 'msg', payload: { text: 'top' }, metadata: { delivery: { seq: 4 } } });
      ws.emit({
        event: 'msg',
        payload: { text: 'ch' },
        metadata: { channel: { name: 'gamma' }, delivery: { seq: 6 } },
      });

      const second = reconnectAfterDrop(ws);
      const replayFrames = second
        .sentFrames()
        .filter((f: { event: string }) => f.event === '__replay__');

      expect(replayFrames).toHaveLength(2);

      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 4 },
        metadata: null,
      });
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 6 },
        metadata: { channel: { name: 'gamma' } },
      });
    });
  });

  describe('unsupported-protocol warning', () => {
    it('warns every time the server reports replay is unsupported, and still passes the error to onServerError', () => {
      const { socket, ws } = build(dedup(), replay(), reconnection());
      socket.setDebug(true);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onError = vi.fn();
      socket.onServerError(onError);

      const errorFrame = {
        event: '__error__',
        payload: { code: 'unsupported-protocol', detail: { event: '__replay__' } },
        metadata: null,
      };

      ws.emit(errorFrame);
      ws.emit(errorFrame);

      const replayWarns = warn.mock.calls.filter((args) =>
        String(args[1] ?? '').includes('replay()'),
      );
      expect(replayWarns).toHaveLength(2);
      expect(onError).toHaveBeenCalledTimes(2);
      expect((onError.mock.calls[0]![0] as { code?: string }).code).toBe('unsupported-protocol');

      warn.mockRestore();
    });

    it('does not warn for an unsupported-protocol error scoped to a different protocol event', () => {
      const { socket, ws } = build(dedup(), replay(), reconnection());
      socket.setDebug(true);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      socket.onServerError(() => {});
      ws.emit({
        event: '__error__',
        payload: { code: 'unsupported-protocol', detail: { event: '__continueStream__' } },
        metadata: { stream: { id: 's-1' } },
      });

      const replayWarns = warn.mock.calls.filter((args) =>
        String(args[1] ?? '').includes('replay()'),
      );
      expect(replayWarns).toHaveLength(0);

      warn.mockRestore();
    });
  });

  describe('high-water mark is monotone', () => {
    it('does not lower the stored seq when a lower seq arrives later', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'a' },
        metadata: { channel: { name: 'delta' }, delivery: { seq: 20 } },
      });
      // Lower seq arrives — must not replace 20
      ws.emit({
        event: 'msg',
        payload: { text: 'b' },
        metadata: { channel: { name: 'delta' }, delivery: { seq: 5 } },
      });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      expect(frames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 20 },
        metadata: { channel: { name: 'delta' } },
      });
    });

    it('updates the stored seq when a higher seq arrives later', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'a' },
        metadata: { channel: { name: 'epsilon' }, delivery: { seq: 3 } },
      });
      ws.emit({
        event: 'msg',
        payload: { text: 'b' },
        metadata: { channel: { name: 'epsilon' }, delivery: { seq: 11 } },
      });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      expect(frames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 11 },
        metadata: { channel: { name: 'epsilon' } },
      });
    });
  });

  describe('stream chunks do not corrupt channel catch-up', () => {
    it('tracks the channel seq, not a stream chunk seq, as the high-water mark', () => {
      const { ws } = build(dedup(), replay(), reconnection());
      ws.emit({
        event: 'msg',
        payload: { text: 'hi' },
        metadata: { channel: { name: 'room-a' }, delivery: { seq: 3 } },
      });
      ws.emit({
        event: 'tokens',
        payload: { text: 'x' },
        metadata: { channel: { name: 'room-a' }, stream: { id: 's-1', seq: 50 } },
      });
      const second = reconnectAfterDrop(ws);

      const frame = second
        .sentFrames()
        .find((f: { event: string; metadata?: { channel?: string } }) => f.event === '__replay__');
      expect(frame.payload).toEqual({ lastKnownSeq: 3 });
    });

    it('does not fabricate a catch-up request from a stream-only channel', () => {
      const { ws } = build(dedup(), replay(), reconnection());
      ws.emit({
        event: 'tokens',
        payload: { text: 'x' },
        metadata: { channel: { name: 'room-b' }, stream: { id: 's-2', seq: 7 } },
      });
      const second = reconnectAfterDrop(ws);

      const frame = second.sentFrames().find((f: { event: string }) => f.event === '__replay__');
      expect(frame).toBeUndefined();
    });
  });

  describe('gap cursor recovery', () => {
    it('advances the replay cursor before gaps() surfaces and consumes the frame', () => {
      const socket = client<C>()(connect('wss://test'), dedup(), gaps(), replay(), reconnection());
      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();
      const onGap = vi.fn();

      socket.onGap(onGap);

      ws.emit({ event: 'msg', payload: { text: 'a' }, metadata: { delivery: { seq: 5 } } });

      const second = reconnectAfterDrop(ws);
      second.emit({ event: '__gap__', payload: { missedThrough: 12 }, metadata: null });

      expect(onGap).toHaveBeenCalledWith({ missedThrough: 12 });

      const third = reconnectAfterDrop(second);
      const replayFrames = third.sentFrames().filter((f) => f.event === '__replay__');

      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 12 },
        metadata: null,
      });
    });
  });
});
