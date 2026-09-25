import { Block } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { intercept } from '~/primitives/intercept.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterceptFn } from '~/primitives/intercept.ts';

interface C {
  channels: {
    general: {
      incoming: { message: { text: string } };
      outgoing: { 'send-message': { text: string } };
    };
  };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

async function joinedRoom(interceptor: InterceptFn) {
  const socket = client<C>()(connect('wss://test'), channels(), intercept(interceptor));
  socket.onError(() => {});
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  const room = socket.channel('general');
  const joined = room.subscribe();
  ws.emit({
    event: '__subscribeOk__',
    payload: {},
    metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
  });
  await joined;

  return { room, ws };
}

describe('intercept runs before channel delivery', () => {
  it('drops a channel message before the channel listener sees it', async () => {
    const { room, ws } = await joinedRoom((message) => {
      if (message.event === 'message') throw Block;
    });
    const listener = vi.fn();
    room.on('message', listener);

    ws.emit({
      event: 'message',
      payload: { text: 'spam' },
      metadata: { channel: { name: 'general' } },
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('can change a channel message before the channel listener sees it', async () => {
    const { room, ws } = await joinedRoom((message) =>
      message.event === 'message' ? { ...message, payload: { text: 'clean' } } : undefined,
    );
    const listener = vi.fn();
    room.on('message', listener);

    ws.emit({
      event: 'message',
      payload: { text: 'raw' },
      metadata: { channel: { name: 'general' } },
    });

    expect(listener).toHaveBeenCalledWith({ text: 'clean' });
  });

  it('does not see protocol frames', async () => {
    const seen: string[] = [];
    await joinedRoom((message) => {
      seen.push(message.event);
    });

    expect(seen).not.toContain('__subscribeOk__');
  });
});
