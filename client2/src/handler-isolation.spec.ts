// A throwing message handler must not stop its siblings (the other handlers for
// the same event) at any scope. The throw is reported on the debug log channel,
// so it stays quiet unless debug logging is on.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { namespaces } from '~/primitives/namespaces/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  incoming: { message: unknown };
  namespaces: { alerts: { incoming: { 'new-alert': unknown } } };
  channels: {
    general: { incoming: { message: unknown } };
    rooms: { [room: string]: { incoming: { message: unknown } } };
  };
  streams: { feed: { payload: unknown; chunks: unknown } };
}

function connectedBase() {
  const socket = client<C>()(connect('wss://test'));
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

function connectedNs() {
  const socket = client<C>()(connect('wss://test'), namespaces());
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
    const calls: string[] = [];
    socket.on('message', () => {
      calls.push('A');
      throw new Error('boom');
    });
    socket.on('message', () => calls.push('B'));

    expect(() => ws.emit({ event: 'message', payload: {} })).not.toThrow();
    expect(calls).toEqual(['A', 'B']);
  });

  it('namespace: a throwing handler still lets the other one run', () => {
    const { socket, ws } = connectedNs();
    const alerts = socket.namespace('alerts');
    const calls: string[] = [];
    alerts.on('new-alert', () => {
      calls.push('A');
      throw new Error('boom');
    });
    alerts.on('new-alert', () => calls.push('B'));

    expect(() =>
      ws.emit({ event: 'new-alert', payload: {}, __wskit: { namespace: 'alerts' } }),
    ).not.toThrow();
    expect(calls).toEqual(['A', 'B']);
  });

  it('channel: a throwing handler still lets the other one run', () => {
    const { socket, ws } = connectedCh();
    const room = socket.channel('general');
    room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
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
    const rooms = socket.channel.scope('rooms');
    socket.channel('rooms', 'lobby').subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'lobby', channelScope: 'rooms' },
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
        __wskit: { channel: 'lobby', channelScope: 'rooms' },
      }),
    ).not.toThrow();
    expect(calls).toEqual(['A', 'B']);
  });
});

describe('a throwing presence or stream callback is isolated from its siblings', () => {
  it('channel presence: a throwing onMemberJoin still lets the other one run', () => {
    const { socket, ws } = connectedCh();
    const room = socket.channel('general');
    room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
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

describe('a throwing handler is reported on the debug channel', () => {
  it('stays silent with debug off and logs once debug is on', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { socket, ws } = connectedBase();
      socket.on('message', () => {
        throw new Error('boom');
      });

      ws.emit({ event: 'message', payload: {} }); // debug off → no log
      expect(errorLog).not.toHaveBeenCalled();

      socket.setDebug(true);
      ws.emit({ event: 'message', payload: {} }); // debug on → logged
      expect(errorLog).toHaveBeenCalledWith(
        '[wskit]',
        'a message handler threw',
        expect.any(Error),
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});
