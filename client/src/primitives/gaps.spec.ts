import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { gaps } from '~/primitives/gaps.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GapInfo } from '~/types.ts';

interface Contract {
  incoming: { message: { text: string } };
  channels: {
    room: {
      incoming: { message: { text: string } };
      outgoing: {};
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

describe('gaps()', () => {
  it('delivers a top-level gap through socket.onGap and not socket.on', () => {
    const socket = client<Contract>()(connect('wss://test'), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const seen: GapInfo[] = [];
    const message = vi.fn();
    socket.onGap((info) => seen.push(info));
    (socket as unknown as { on(event: string, callback: () => void): void }).on('__gap__', message);

    ws.emit({ event: '__gap__', payload: { missedThrough: 12 }, __wskit: {} });

    expect(seen).toEqual([{ missedThrough: 12 }]);
    expect(message).not.toHaveBeenCalled();
  });

  it('routes a channel gap only to that channel handle', () => {
    const socket = client<Contract>()(connect('wss://test'), channels(), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const socketGaps: GapInfo[] = [];
    const roomGaps: GapInfo[] = [];
    const message = vi.fn();
    socket.onGap((info) => socketGaps.push(info));
    const room = socket.channel('room');
    room.onGap((info) => roomGaps.push(info));
    room.on('__gap__' as 'message', message);

    ws.emit({ event: '__gap__', payload: { missedThrough: 7 }, __wskit: { channel: 'room' } });

    expect(roomGaps).toEqual([{ missedThrough: 7, channel: 'room' }]);
    expect(socketGaps).toEqual([]);
    expect(message).not.toHaveBeenCalled();
  });

  it('keeps dynamic channels with the same name isolated by family', () => {
    interface FamilyContract {
      channels: {
        rooms: { addressing: 'dynamic'; incoming: {}; outgoing: {} };
        topics: { addressing: 'dynamic'; incoming: {}; outgoing: {} };
      };
    }
    const socket = client<FamilyContract>()(connect('wss://test'), channels(), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const roomGaps: GapInfo[] = [];
    const topicGaps: GapInfo[] = [];
    socket.channel('rooms', 'general').onGap((info) => roomGaps.push(info));
    socket.channel('topics', 'general').onGap((info) => topicGaps.push(info));

    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 4 },
      __wskit: { channel: 'general', channelFamily: 'rooms' },
    });

    expect(roomGaps).toEqual([{ missedThrough: 4, channel: 'general', channelFamily: 'rooms' }]);
    expect(topicGaps).toEqual([]);
  });

  it('stops delivering after the listener unsubscribes', () => {
    const socket = client<Contract>()(connect('wss://test'), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const listener = vi.fn();
    const off = socket.onGap(listener);
    off();

    ws.emit({ event: '__gap__', payload: { missedThrough: 3 }, __wskit: {} });

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops delivering to a channel listener after it unsubscribes', () => {
    const socket = client<Contract>()(connect('wss://test'), channels(), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const listener = vi.fn();
    const off = socket.channel('room').onGap(listener);
    off();

    ws.emit({ event: '__gap__', payload: { missedThrough: 3 }, __wskit: { channel: 'room' } });

    expect(listener).not.toHaveBeenCalled();
  });

  it('consumes a malformed gap without calling listeners or leaking it', () => {
    const socket = client<Contract>()(connect('wss://test'), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const gapListener = vi.fn();
    const messageListener = vi.fn();
    socket.onGap(gapListener);
    (socket as unknown as { on(event: string, callback: () => void): void }).on(
      '__gap__',
      messageListener,
    );

    ws.emit({ event: '__gap__', payload: { missedThrough: 'bad' }, __wskit: {} });

    expect(gapListener).not.toHaveBeenCalled();
    expect(messageListener).not.toHaveBeenCalled();
  });
});
