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

      // Top-level replay has no __wskit block
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 4 },
      });
      // Channel replay
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 6 },
        __wskit: { channel: 'gamma' },
      });
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
