// A throwing message handler must not stop its siblings (the other handlers for
// the same event) at any scope. The throw is reported on the debug log channel,
// so it stays quiet unless debug logging is on.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { namespaces } from '~/primitives/namespaces/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- loose for brevity
function connected(...primitives: any[]) {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- loose for brevity
  const socket = (client<any>() as any)(connect('wss://test'), ...primitives);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

describe('a throwing message handler is isolated from its siblings', () => {
  it('top level: a throwing on() handler still lets the other one run', () => {
    const { socket, ws } = connected();
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
    const { socket, ws } = connected(namespaces());
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
    const { socket, ws } = connected(channels());
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
    const { socket, ws } = connected(channels());
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

describe('a throwing handler is reported on the debug channel', () => {
  it('stays silent with debug off and logs once debug is on', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { socket, ws } = connected();
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
