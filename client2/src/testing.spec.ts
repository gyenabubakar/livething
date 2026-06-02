import { Block } from '@wskit/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { intercept } from '~/primitives/intercept.ts';
import { namespaces } from '~/primitives/namespaces/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { inject, injectChannel, injectNamespace } from '~/testing.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from '~/socket/api.ts';

interface C {
  incoming: { message: { text: string }; blocked: { x: number } };
  channels: {
    general: {
      incoming: { message: { text: string } };
      outgoing: { 'send-message': { text: string } };
    };
  };
  namespaces: {
    alerts: {
      incoming: { 'new-alert': { level: string } };
      outgoing: { dismiss: { id: string } };
    };
  };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
function make(...primitives: any[]) {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
  return (client<C>() as any)(connect('wss://test'), ...primitives);
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('inject', () => {
  it('dispatches through the pipeline to on() handlers, even while disconnected', () => {
    const socket = make();
    const handler = vi.fn();
    socket.on('message', handler);

    inject(socket as Socket<C>, 'message', { text: 'hi' });
    expect(handler).toHaveBeenCalledWith({ text: 'hi' });
    expect(socket.getState()).toBe('closed'); // no live connection needed
  });

  it('respects intercept Block', () => {
    const socket = make(
      intercept((m: { event: string }) => {
        if (m.event === 'blocked') throw Block;
      }),
    );
    const handler = vi.fn();
    socket.on('blocked', handler);

    inject(socket as Socket<C>, 'blocked', { x: 1 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('injectChannel', () => {
  it('routes a tagged frame to channel handlers', async () => {
    const socket = make(channels());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const room = socket.channel('general');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;

    const handler = vi.fn();
    room.on('message', handler);

    injectChannel(socket as Socket<C>, 'general', 'message', { text: 'in-channel' });
    expect(handler).toHaveBeenCalledWith({ text: 'in-channel' });
  });
});

describe('injectNamespace', () => {
  it('routes a tagged frame to namespace handlers, even while disconnected', () => {
    const socket = make(namespaces());
    const handler = vi.fn();
    socket.namespace('alerts').on('new-alert', handler);

    injectNamespace(socket as Socket<C>, 'alerts', 'new-alert', { level: 'critical' });
    expect(handler).toHaveBeenCalledWith({ level: 'critical' });
  });
});
