// A throwing message handler must not stop its siblings (the other handlers for
// the same event) at any scope. The throw is surfaced on the `error` event, or
// the console when nothing is listening — never silently swallowed.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  incoming: { message: unknown };
  channels: {
    general: { incoming: { message: unknown } };
    rooms: { addressing: 'dynamic'; incoming: { message: unknown } };
  };
  streams: { feed: { payload: unknown; chunk: unknown } };
}

function connectedBase() {
  const socket = client<C>()(connect('wss://test'));
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

function connectedCh() {
  const socket = client<C>()(connect('wss://test'), channels());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

function connectedSt() {
  const socket = client<C>()(connect('wss://test'), stream());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('a throwing message handler is isolated from its siblings', () => {
  it('top level: a throwing on() handler still lets the other one run', () => {
    const { socket, ws } = connectedBase();
    socket.onError(() => {});
    const calls: string[] = [];
    socket.on('message', () => {
      calls.push('A');
      throw new Error('boom');
    });
    socket.on('message', () => calls.push('B'));

    expect(() => ws.emit({ event: 'message', payload: {} })).not.toThrow();
    expect(calls).toEqual(['A', 'B']);
  });

  it('channel: a throwing handler still lets the other one run', () => {
    const { socket, ws } = connectedCh();
    socket.onError(() => {});
    const room = socket.channel('general');
    room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });

    const calls: string[] = [];
    room.on('message', () => {
      calls.push('A');
      throw new Error('boom');
    });
    room.on('message', () => calls.push('B'));

    expect(() =>
      ws.emit({ event: 'message', payload: {}, __wskit: { channel: 'general' } }),
    ).not.toThrow();
    expect(calls).toEqual(['A', 'B']);
  });

  it('channel family: a throwing family handler still lets the other one run', () => {
    const { socket, ws } = connectedCh();
    socket.onError(() => {});
    const rooms = socket.channel.family('rooms');
    socket.channel('rooms', 'lobby').subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'lobby', channelFamily: 'rooms' },
    });

    const calls: string[] = [];
    rooms.on('message', () => {
      calls.push('A');
      throw new Error('boom');
    });
    rooms.on('message', () => calls.push('B'));

    expect(() =>
      ws.emit({
        event: 'message',
        payload: {},
        __wskit: { channel: 'lobby', channelFamily: 'rooms' },
      }),
    ).not.toThrow();
    expect(calls).toEqual(['A', 'B']);
  });
});

describe('a throwing presence or stream callback is isolated from its siblings', () => {
  it('channel presence: a throwing onMemberJoin still lets the other one run', () => {
    const { socket, ws } = connectedCh();
    socket.onError(() => {});
    const room = socket.channel('general');
    room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });

    const calls: string[] = [];
    room.onMemberJoin(() => {
      calls.push('A');
      throw new Error('boom');
    });
    room.onMemberJoin(() => calls.push('B'));

    expect(() =>
      ws.emit({
        event: '__memberJoin__',
        payload: { connectionId: 'c1' },
        __wskit: { channel: 'general' },
      }),
    ).not.toThrow();
    expect(calls).toEqual(['A', 'B']);
  });

  it('stream broadcast: a throwing onChunk still lets another subscriber receive', () => {
    const { socket, ws } = connectedSt();
    socket.onError(() => {});
    const calls: string[] = [];
    socket.onStream('feed', {
      onChunk: () => {
        calls.push('A');
        throw new Error('boom');
      },
    });
    socket.onStream('feed', { onChunk: () => calls.push('B') });

    expect(() =>
      ws.emit({ event: 'feed', payload: {}, __wskit: { streamId: 's1' } }),
    ).not.toThrow();
    expect(calls).toEqual(['A', 'B']);
  });
});

describe('a throwing handler is surfaced, not swallowed', () => {
  it('surfaces the raw thrown value on the error event', () => {
    const { socket, ws } = connectedBase();
    const boom = new Error('boom');
    const onError = vi.fn();
    socket.onError(onError);
    socket.on('message', () => {
      throw boom;
    });

    ws.emit({ event: 'message', payload: {} });
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('rethrows out-of-band to the global handler when nothing is listening', () => {
    const scheduled: Array<() => void> = [];
    const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb) => {
      scheduled.push(cb);
    });
    try {
      const { socket, ws } = connectedBase();
      const boom = new Error('boom');
      socket.on('message', () => {
        throw boom;
      });

      ws.emit({ event: 'message', payload: {} });
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toThrow(boom);
    } finally {
      queue.mockRestore();
    }
  });

  it('does not loop when an error listener itself throws', () => {
    const scheduled: Array<() => void> = [];
    const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb) => {
      scheduled.push(cb);
    });
    try {
      const { socket, ws } = connectedBase();
      socket.onError(() => {
        throw new Error('listener boom');
      });
      socket.on('message', () => {
        throw new Error('handler boom');
      });

      expect(() => ws.emit({ event: 'message', payload: {} })).not.toThrow();
      expect(scheduled).toHaveLength(1);
    } finally {
      queue.mockRestore();
    }
  });
});
