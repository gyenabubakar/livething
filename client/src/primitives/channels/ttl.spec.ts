import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BufferingOptions } from '~/primitives/buffering/index.ts';
import type { ChannelsOptions } from '~/primitives/channels/index.ts';

interface C {
  channels: {
    general: {
      incoming: Record<string, never>;
      outgoing: { chat: { text: string }; typing: { who: string } };
    };
  };
}

function buildDisconnected(channelsOpts: ChannelsOptions, bufferingOpts: BufferingOptions) {
  return client<C>()(connect('wss://test'), channels(channelsOpts), buffering(bufferingOpts));
}

/**
 * Subscribe a channel while connected, then drop the connection so subsequent
 * sends buffer. Returns the active channel handle and the socket.
 */
async function buildActiveAndDrop(channelsOpts: ChannelsOptions, bufferingOpts: BufferingOptions) {
  const socket = buildDisconnected(channelsOpts, bufferingOpts);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  const room = socket.channel('general');
  const subscribePromise = room.subscribe();
  ws.emit({
    event: '__subscribeOk__',
    payload: {},
    __wskit: { source: 'client', channel: 'general' },
  });
  await subscribePromise;

  ws.serverClose(1006, 'drop');
  return { socket, room };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('channels resolveTtl', () => {
  describe('global number ttl', () => {
    it('propagates the number ttl to the buffer so an expired message is dropped on flush', async () => {
      vi.useFakeTimers();

      const { socket, room } = await buildActiveAndDrop({ ttl: 500 }, { enabled: true });

      room.send('chat', { text: 'hello' });

      vi.advanceTimersByTime(600);

      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();

      const chatFrames = ws.sentFrames().filter((f) => f.event === 'chat');
      expect(chatFrames).toHaveLength(0);
    });

    it('delivers a message that has not expired yet', async () => {
      vi.useFakeTimers();

      const { socket, room } = await buildActiveAndDrop({ ttl: 500 }, { enabled: true });

      room.send('chat', { text: 'fresh' });

      vi.advanceTimersByTime(100);

      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();

      expect(ws.sentFrames()).toContainEqual(
        expect.objectContaining({ event: 'chat', payload: { text: 'fresh' } }),
      );
    });
  });

  describe('per-event map ttl — map hit', () => {
    it('uses the event-specific ttl when the event appears in the map', async () => {
      vi.useFakeTimers();

      const { socket, room } = await buildActiveAndDrop(
        { ttl: { typing: 200 } },
        { enabled: true },
      );

      room.send('typing', { who: 'Ada' });

      vi.advanceTimersByTime(300);

      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();

      const typingFrames = ws.sentFrames().filter((f) => f.event === 'typing');
      expect(typingFrames).toHaveLength(0);
    });
  });

  describe('per-event map ttl — map miss', () => {
    it('sends no ttl to the buffer when the event is absent from the map, so the message survives', async () => {
      vi.useFakeTimers();

      const { socket, room } = await buildActiveAndDrop(
        { ttl: { typing: 200 } },
        { enabled: true },
      );

      room.send('chat', { text: 'important' });

      vi.advanceTimersByTime(10_000);

      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();

      expect(ws.sentFrames()).toContainEqual(
        expect.objectContaining({ event: 'chat', payload: { text: 'important' } }),
      );
    });
  });

  describe('per-call override', () => {
    it('per-call ttl option beats the global channels ttl', async () => {
      vi.useFakeTimers();

      const { socket, room } = await buildActiveAndDrop({ ttl: 10_000 }, { enabled: true });

      room.send('chat', { text: 'override' }, { ttl: 100 });

      vi.advanceTimersByTime(200);

      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();

      const chatFrames = ws.sentFrames().filter((f) => f.event === 'chat');
      expect(chatFrames).toHaveLength(0);
    });

    it('per-call ttl option beats the map-based channels ttl', async () => {
      vi.useFakeTimers();

      const { socket, room } = await buildActiveAndDrop(
        { ttl: { chat: 10_000 } },
        { enabled: true },
      );

      room.send('chat', { text: 'map-override' }, { ttl: 100 });

      vi.advanceTimersByTime(200);

      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();

      const chatFrames = ws.sentFrames().filter((f) => f.event === 'chat');
      expect(chatFrames).toHaveLength(0);
    });
  });
});
