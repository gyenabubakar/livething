import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { replay } from '~/primitives/replay.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { GapInfo } from '~/types.ts';

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

      ws.emit({ event: 'msg', payload: { text: 'hi' }, __wskit: { channel: 'room-a', seq: 3 } });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

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

      const topLevelReplay = frames.find(
        (f: { event: string; __wskit?: unknown }) =>
          f.event === '__replay__' && f.__wskit === undefined,
      );
      expect(topLevelReplay).toBeUndefined();
    });

    it('tracks two channels that share a name in different scopes separately', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'a' },
        __wskit: { channel: 'lobby', channelFamily: 'rooms', seq: 5 },
      });
      ws.emit({
        event: 'msg',
        payload: { text: 'b' },
        __wskit: { channel: 'lobby', channelFamily: 'tenants', seq: 9 },
      });

      const second = reconnectAfterDrop(ws);
      const replayFrames = second.sentFrames().filter((f) => f.event === '__replay__');

      // Each scope must get its own catch-up — they must not collapse into one.
      expect(replayFrames).toHaveLength(2);
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 5 },
        __wskit: { channel: 'lobby', channelFamily: 'rooms' },
      });
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 9 },
        __wskit: { channel: 'lobby', channelFamily: 'tenants' },
      });
    });
  });

  describe('channelFamily included in catch-up request', () => {
    it('attaches channelFamily to the __replay__ frame when the message had one', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({
        event: 'msg',
        payload: { text: 'scoped' },
        __wskit: { channel: 'room-b', channelFamily: 'tenant-1', seq: 10 },
      });

      const second = reconnectAfterDrop(ws);
      const frames = second.sentFrames();

      expect(frames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 10 },
        __wskit: { channel: 'room-b', channelFamily: 'tenant-1' },
      });
    });

    it('omits channelFamily from the frame when the original message had none', () => {
      const { ws } = build(dedup(), replay(), reconnection());

      ws.emit({ event: 'msg', payload: { text: 'plain' }, __wskit: { channel: 'room-c', seq: 2 } });

      const second = reconnectAfterDrop(ws);
      const replayFrame = second
        .sentFrames()
        .find((f: { event: string }) => f.event === '__replay__');

      expect(replayFrame).toBeDefined();
      expect(replayFrame.__wskit).not.toHaveProperty('channelFamily');
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

      ws.emit({ event: 'msg', payload: { text: 'top' }, __wskit: { seq: 4 } });
      ws.emit({ event: 'msg', payload: { text: 'ch' }, __wskit: { channel: 'gamma', seq: 6 } });

      const second = reconnectAfterDrop(ws);
      const replayFrames = second
        .sentFrames()
        .filter((f: { event: string }) => f.event === '__replay__');

      expect(replayFrames).toHaveLength(2);

      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 4 },
        __wskit: {},
      });
      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 6 },
        __wskit: { channel: 'gamma' },
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
        __wskit: {},
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

  describe('stream chunks do not corrupt channel catch-up', () => {
    it('tracks the channel seq, not a stream chunk seq, as the high-water mark', () => {
      const { ws } = build(dedup(), replay(), reconnection());
      ws.emit({ event: 'msg', payload: { text: 'hi' }, __wskit: { channel: 'room-a', seq: 3 } });
      ws.emit({
        event: 'tokens',
        payload: { text: 'x' },
        __wskit: { channel: 'room-a', streamId: 's-1', seq: 50 },
      });
      const second = reconnectAfterDrop(ws);

      const frame = second
        .sentFrames()
        .find((f: { event: string; __wskit?: { channel?: string } }) => f.event === '__replay__');
      expect(frame.payload).toEqual({ lastKnownSeq: 3 });
    });

    it('does not fabricate a catch-up request from a stream-only channel', () => {
      const { ws } = build(dedup(), replay(), reconnection());
      ws.emit({
        event: 'tokens',
        payload: { text: 'x' },
        __wskit: { channel: 'room-b', streamId: 's-2', seq: 7 },
      });
      const second = reconnectAfterDrop(ws);

      const frame = second.sentFrames().find((f: { event: string }) => f.event === '__replay__');
      expect(frame).toBeUndefined();
    });
  });

  describe('onGap delivery', () => {
    it('fires socket.onGap for a top-level gap frame', () => {
      const { socket, ws } = build(dedup(), replay(), reconnection());
      const seen: GapInfo[] = [];
      // build()'s generic primitive spread erases replay()'s type function, so
      // socket.onGap isn't visible on this contract-C socket type at compile time.
      // @ts-expect-error — onGap is present at runtime; see the direct-client test below for the typed path
      socket.onGap((info: GapInfo) => seen.push(info));

      ws.emit({ event: '__gap__', payload: { missedThrough: 12 }, __wskit: {} });

      expect(seen).toEqual([{ missedThrough: 12 }]);
    });

    it('advances the scope cursor to missedThrough, so a second reconnect asks past the gap instead of repeating it', () => {
      const { socket, ws } = build(dedup(), replay(), reconnection());
      const seen: GapInfo[] = [];
      // @ts-expect-error — onGap is present at runtime; see the direct-client test below for the typed path
      socket.onGap((info: GapInfo) => seen.push(info));

      ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { seq: 5 } });

      const second = reconnectAfterDrop(ws);
      second.emit({ event: '__gap__', payload: { missedThrough: 12 }, __wskit: {} });

      const third = reconnectAfterDrop(second);
      const replayFrames = third.sentFrames().filter((f) => f.event === '__replay__');

      expect(replayFrames).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 12 },
        __wskit: {},
      });
      // Only the one gap seen above — a stale cursor would report the same
      // gap again on every subsequent reconnect.
      expect(seen).toEqual([{ missedThrough: 12 }]);
    });

    it('does not leak the __gap__ frame to a user .on() message handler', () => {
      const { socket, ws } = build(dedup(), replay(), reconnection());
      const onGap = vi.fn();
      const onMessage = vi.fn();
      // @ts-expect-error — build() erases replay()'s type function; onGap exists at runtime
      socket.onGap(onGap);
      socket.on('__gap__' as 'msg', onMessage);

      ws.emit({ event: '__gap__', payload: { missedThrough: 3 }, __wskit: {} });

      expect(onGap).toHaveBeenCalledTimes(1);
      expect(onMessage).not.toHaveBeenCalled();
    });
  });
});

interface ChannelContract {
  channels: {
    room: {
      incoming: { msg: { text: string } };
      outgoing: { chat: { text: string } };
    };
  };
}

describe('replay — channel onGap delivery', () => {
  let restoreWs: () => void;
  beforeEach(() => {
    restoreWs = installMockWebSocket();
  });
  afterEach(() => {
    restoreWs();
  });

  function buildChannel() {
    const socket = client<ChannelContract>()(
      connect('wss://test'),
      channels(),
      dedup(),
      replay(),
      reconnection(),
    );
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    return { socket, ws };
  }

  it('routes a channel-scoped gap only to that channel handle, not the socket or other channels', () => {
    const { socket, ws } = buildChannel();
    const roomGap: GapInfo[] = [];
    const socketGap: GapInfo[] = [];
    socket.channel('room').onGap((info) => roomGap.push(info));
    socket.onGap((info) => socketGap.push(info));

    ws.emit({ event: '__gap__', payload: { missedThrough: 8 }, __wskit: { channel: 'room' } });

    expect(roomGap).toEqual([{ missedThrough: 8, channel: 'room' }]);
    expect(socketGap).toEqual([]);
  });

  it('does not leak a channel gap to the channel .on() message handler', () => {
    const { socket, ws } = buildChannel();
    const onGap = vi.fn();
    const onMessage = vi.fn();
    const room = socket.channel('room');
    room.onGap(onGap);
    room.on('__gap__' as 'msg', onMessage);

    ws.emit({ event: '__gap__', payload: { missedThrough: 2 }, __wskit: { channel: 'room' } });

    expect(onGap).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('channel.onGap throws a clear error when replay() is not installed', () => {
    // onGap is on the channel handle type unconditionally (it is not contract-gated),
    // so without replay() it must throw a helpful error rather than fail with a bare
    // "onGap is not a function".
    const socket = client<ChannelContract>()(connect('wss://test'), channels());
    socket.connect();
    MockWebSocket.last().open();

    expect(() => socket.channel('room').onGap(() => {})).toThrow(/replay\(\)/);
  });
});
