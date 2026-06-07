import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { dedup } from '~/primitives/dedup.ts';
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

describe('replay — per-channel scope catch-up', () => {
  describe('channel-scoped seq tracking', () => {
    it('tracks seq under the channel name, not the top-level key', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      // A channel-scoped message — should be tracked under 'room-a', not ''
      ws.emit({ event: 'msg', payload: { text: 'hi' }, __wskit: { channel: 'room-a', seq: 3 } });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      // Must contain a channel-scoped replay for 'room-a'
      expect(frames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 3 },
        __wskit: { channel: 'room-a' },
      });
    });

    it('does not emit a top-level __replay__ when only channel-scoped messages were seen', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({ event: 'msg', payload: { text: 'hi' }, __wskit: { channel: 'room-a', seq: 7 } });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      // No __replay__ without a __wskit block (top-level)
      const topLevelReplay = frames.find(
        (f: { event: string; __wskit?: unknown }) =>
          f.event === '__replay__' && f.__wskit === undefined,
      );
      expect(topLevelReplay).toBeUndefined();
    });

    it('tracks two channels that share a name in different scopes separately', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      // Same channel name 'lobby' in two different families (scopes).
      ws.emit({
        event: 'msg',
        payload: { text: 'a' },
        __wskit: { channel: 'lobby', channelScope: 'rooms', seq: 5 },
      });
      ws.emit({
        event: 'msg',
        payload: { text: 'b' },
        __wskit: { channel: 'lobby', channelScope: 'tenants', seq: 9 },
      });

      const second = reconnectAfterDrop(ws);
      const replayFrames = second.sentFrames().filter((f) => f.event === '__replay__');

      // Each scope must get its own catch-up — they must not collapse into one.
      expect(replayFrames).toHaveLength(2);
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 5 },
        __wskit: { channel: 'lobby', channelScope: 'rooms' },
      });
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 9 },
        __wskit: { channel: 'lobby', channelScope: 'tenants' },
      });
    });
  });

  describe('channelScope included in catch-up request', () => {
    it('attaches channelScope to the __replay__ frame when the message had one', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'scoped' },
        __wskit: { channel: 'room-b', channelScope: 'tenant-1', seq: 10 },
      });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      expect(frames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 10 },
        __wskit: { channel: 'room-b', channelScope: 'tenant-1' },
      });
    });

    it('omits channelScope from the frame when the original message had none', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({ event: 'msg', payload: { text: 'plain' }, __wskit: { channel: 'room-c', seq: 2 } });

      const second = reconnectAfterDrop(ws);
      const replayFrame = second
        .sentFrames()
        .find((f: { event: string }) => f.event === '__replay__');

      expect(replayFrame).toBeDefined();
      expect(replayFrame.__wskit).not.toHaveProperty('channelScope');
    });
  });

  describe('distinct channels each get their own catch-up request', () => {
    it('produces one __replay__ per channel when two distinct channels received messages', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'alpha', seq: 1 } });
      ws.emit({ event: 'msg', payload: { text: 'b' }, __wskit: { channel: 'beta', seq: 9 } });

      const second = reconnectAfterDrop(ws);
      const replayFrames = second
        .sentFrames()
        .filter((f: { event: string }) => f.event === '__replay__');

      expect(replayFrames).toHaveLength(2);

      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 1 },
        __wskit: { channel: 'alpha' },
      });
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 9 },
        __wskit: { channel: 'beta' },
      });
    });

    it('tracks top-level and channel-scoped seqs independently', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      // Top-level (no channel)
      ws.emit({ event: 'msg', payload: { text: 'top' }, __wskit: { seq: 4 } });
      // Channel-scoped
      ws.emit({ event: 'msg', payload: { text: 'ch' }, __wskit: { channel: 'gamma', seq: 6 } });

      const second = reconnectAfterDrop(ws);
      const replayFrames = second
        .sentFrames()
        .filter((f: { event: string }) => f.event === '__replay__');

      expect(replayFrames).toHaveLength(2);

      // Top-level replay carries an empty __wskit block (the server's replay
      // frame requires the envelope, even with no scope markers).
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 4 },
        __wskit: {},
      });
      // Channel replay
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 6 },
        __wskit: { channel: 'gamma' },
      });
    });
  });

  describe('unsupported-protocol warning', () => {
    it('warns every time the server reports replay is unsupported, and still passes the error to onError', () => {
      const { socket, ws } = build(dedup(), replay(), reconnection());
      socket.setDebug(true);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onError = vi.fn();
      socket.onError(onError);

      const errorFrame = {
        event: '__error__',
        payload: { code: 'unsupported-protocol', detail: { event: '__replay__' } },
        __wskit: {},
      };

      ws.emit(errorFrame);
      ws.emit(errorFrame);

      const replayWarns = warn.mock.calls.filter((args) =>
        String(args[1] ?? '').includes('replay()'),
      );
      expect(replayWarns).toHaveLength(2);
      // The error still surfaces to onError — the primitive only warns, it does
      // not swallow the frame.
      expect(onError).toHaveBeenCalledTimes(2);
      expect((onError.mock.calls[0]![0] as { code?: string }).code).toBe('unsupported-protocol');

      warn.mockRestore();
    });

    it('does not warn for an unsupported-protocol error scoped to a different protocol event', () => {
      const { socket, ws } = build(dedup(), replay(), reconnection());
      socket.setDebug(true);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      ws.emit({
        event: '__error__',
        payload: { code: 'unsupported-protocol', detail: { event: '__resumeStream__' } },
        __wskit: { streamId: 's-1' },
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

      ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'delta', seq: 20 } });
      // Lower seq arrives — must not replace 20
      ws.emit({ event: 'msg', payload: { text: 'b' }, __wskit: { channel: 'delta', seq: 5 } });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      expect(frames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 20 },
        __wskit: { channel: 'delta' },
      });
    });

    it('updates the stored seq when a higher seq arrives later', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'epsilon', seq: 3 } });
      ws.emit({ event: 'msg', payload: { text: 'b' }, __wskit: { channel: 'epsilon', seq: 11 } });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      expect(frames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 11 },
        __wskit: { channel: 'epsilon' },
      });
    });
  });
});
