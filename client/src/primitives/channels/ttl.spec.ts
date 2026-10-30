import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BufferingOptions } from '~/primitives/buffering/index.ts';

interface C {
  channels: {
    general: {
      incoming: Record<string, never>;
      outgoing: { chat: { text: string } };
    };
  };
}

/**
 * Subscribe a channel while connected, then drop the connection so later sends
 * buffer. Returns the active channel handle and the socket.
 */
async function buildActiveAndDrop(bufferingOpts: BufferingOptions) {
  const socket = client<C>()(connect('wss://test'), channels(), buffering(bufferingOpts));
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  const room = socket.channel('general');
  const subscribePromise = room.subscribe();
  ws.emit({
    event: '__subscribeOk__',
    payload: {},
    metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
  });
  await subscribePromise;

  ws.serverClose(1006, 'drop');

  return { socket, room };
}

function reconnectAndChatFrames(socket: Awaited<ReturnType<typeof buildActiveAndDrop>>['socket']) {
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return ws.sentFrames().filter((f) => f.event === 'chat');
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('channel sends and the buffer TTL', () => {
  it('drops a buffered channel send once the buffering() ttl runs out', async () => {
    vi.useFakeTimers();
    const { socket, room } = await buildActiveAndDrop({ ttl: 500 });

    room.send('chat', { text: 'hello' });
    vi.advanceTimersByTime(600);

    expect(reconnectAndChatFrames(socket)).toHaveLength(0);
  });

  it('delivers a buffered channel send that has not expired yet', async () => {
    vi.useFakeTimers();
    const { socket, room } = await buildActiveAndDrop({ ttl: 500 });

    room.send('chat', { text: 'fresh' });
    vi.advanceTimersByTime(100);

    expect(reconnectAndChatFrames(socket)).toContainEqual(
      expect.objectContaining({ event: 'chat', payload: { text: 'fresh' } }),
    );
  });

  it('lets a per-call ttl beat the buffering() ttl', async () => {
    vi.useFakeTimers();
    const { socket, room } = await buildActiveAndDrop({ ttl: 10_000 });

    room.send('chat', { text: 'override' }, { ttl: 100 });
    vi.advanceTimersByTime(200);

    expect(reconnectAndChatFrames(socket)).toHaveLength(0);
  });
});
