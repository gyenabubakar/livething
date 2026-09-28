import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { channels } from '~/primitives/channels/channels.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message, PrimitiveRuntime } from '~/internal/runtime.ts';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { LiveThingSocket } from '~/socket/socket.ts';

interface TestContract {
  incoming: { response: { data: string } };
  outgoing: { action: { id: number }; update: { value: string } };
  channels: { room: { outgoing: { update: { value: string } } } };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function buildSocket<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<TestContract, P>
): LiveThingSocket {
  return client<TestContract>()(connect('wss://test'), ...primitives) as unknown as LiveThingSocket;
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function openedSocket<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<TestContract, P>
): { socket: LiveThingSocket; ws: MockWebSocket } {
  const socket = buildSocket(...primitives);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

describe('send rejects reserved event names', () => {
  it('drops a reserved event name locally (returns false, nothing on the wire)', () => {
    const { socket, ws } = openedSocket();
    const send = socket.send.bind(socket) as (e: string, p: unknown) => boolean;
    for (const name of ['__subscribe__', '__custom', '__error__', '']) {
      expect(send(name, { id: 1 })).toBe(false);
    }

    expect(ws.sentFrames()).toHaveLength(0);
  });

  it('a channel send drops a reserved event name locally', async () => {
    const { socket, ws } = openedSocket(channels());
    const room = (socket as unknown as { channel(name: string): unknown }).channel('room') as {
      subscribe(): Promise<void>;
      send(e: string, p: unknown): boolean;
    };
    void room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'room' } },
    });
    const before = ws.sentFrames().length;

    expect(room.send('__custom', { value: 'x' })).toBe(false);
    expect(ws.sentFrames().length).toBe(before);
  });
});

describe('queued frame isolation on open (#10)', () => {
  it('isolates a bad queued frame so valid frames behind it still send', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const framePrimitive: PrimitiveRuntime = {
      id: 'frames',
      onOpen: () => [
        { event: 'bad', payload: circular },
        { event: 'good', payload: { ok: 1 } },
      ],
    };

    const errors: unknown[] = [];
    const socket = buildSocket();

    socket.onError((error) => errors.push(error));
    socket._setPrimitives([framePrimitive]);
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    expect(ws.sentFrames().some((f) => f.event === 'good')).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('_send: onOutgoing null cancels before buffering fallback', () => {
  it('returns false immediately when onOutgoing cancels — does not queue the message', () => {
    const cancellingPrimitive: PrimitiveRuntime = {
      id: 'canceller',
      onOutgoing() {
        return null;
      },
    };

    const socket = buildSocket(buffering({ enabled: true }));
    const existing = (socket as LiveThingSocket)._primitives;
    (socket as LiveThingSocket)._setPrimitives([cancellingPrimitive, ...existing]);

    expect(socket._state).toBe('closed');

    const result = socket.send('action', { id: 1 });

    expect(result).toBe(false);
  });

  it('cancelled message is not replayed on reconnect after buffering is installed', () => {
    const cancellingPrimitive: PrimitiveRuntime = {
      id: 'canceller',
      onOutgoing() {
        return null;
      },
    };

    const socket = buildSocket(buffering({ enabled: true }));
    const existing = (socket as LiveThingSocket)._primitives;
    (socket as LiveThingSocket)._setPrimitives([cancellingPrimitive, ...existing]);

    socket.send('action', { id: 2 });

    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    // The cancelled message must NOT appear in the wire frames
    const frames = ws.sentFrames();
    expect(frames.some((f) => f.event === 'action')).toBe(false);
  });
});

describe('_send: return value — true when buffered, false when dropped', () => {
  it('channel.send throws ChannelNotSubscribed before reaching _send when unsubscribed', () => {
    // Channel enforces subscription at the messaging level — the _send false-return
    // path is unreachable for channels without a prior subscribe(). This is the
    // actual current behavior: the guard throws, not returns false.
    const socket = client<TestContract>()(connect('wss://test'), channels());
    const ch = socket.channel('room');
    expect(socket.state.get()).toBe('closed');

    expect(() => ch.send('update', { value: 'x' })).toThrow();
  });

  it('returns true when buffering(enabled:true) is installed and socket is disconnected', () => {
    const socket = buildSocket(buffering({ enabled: true }));
    const result = socket.send('action', { id: 10 });
    expect(result).toBe(true);
  });

  it('returns false when buffering(enabled:false) is installed and socket is disconnected', () => {
    const socket = buildSocket(buffering({ enabled: false }));
    const result = socket.send('action', { id: 11 });
    expect(result).toBe(false);
  });
});

describe('_rawSend: dropped while socket is not open', () => {
  it('does not call ws.send when state is not open', () => {
    const socket = buildSocket();
    const before = MockWebSocket.instances.length;

    socket._rawSend({ event: 'ping', payload: {} });

    expect(MockWebSocket.instances.length).toBe(before);
  });

  it('does not throw when called with no ws', () => {
    const socket = buildSocket();
    expect(() => socket._rawSend({ event: 'test', payload: {} })).not.toThrow();
  });

  it('drops the frame when called after disconnect (ws nulled out)', () => {
    const { socket, ws } = openedSocket();
    socket.disconnect();

    const framesBefore = ws.sent.length;
    socket._rawSend({ event: 'late', payload: {} });

    expect(ws.sent.length).toBe(framesBefore);
  });

  it('drops a frame sent via helpers.rawSend before the socket opens', () => {
    let rawSendRef: ((m: Message) => void) | null = null;
    const spy: PrimitiveRuntime = {
      id: 'raw-spy',
    };

    const socket = buildSocket();
    socket._setPrimitives([spy]);

    rawSendRef = (m: Message) => socket._rawSend(m);

    rawSendRef({ event: 'early', payload: {} });

    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    // The 'early' frame must not appear
    expect(ws.sentFrames().some((f) => f.event === 'early')).toBe(false);
  });

  it('sends normally through _rawSend when socket IS open', () => {
    const { socket, ws } = openedSocket();
    socket._rawSend({ event: 'direct', payload: { x: 1 } });
    expect(ws.sentFrames()).toContainEqual({ event: 'direct', payload: { x: 1 }, metadata: null });
  });
});

describe('dropped send debug log uses the renamed event name', () => {
  it('debug drop log contains the outgoing (renamed) event, not the original', () => {
    const renamingPrimitive: PrimitiveRuntime = {
      id: 'renamer',
      onOutgoing(message) {
        return { ...message, event: 'renamed-action' };
      },
    };

    const socket = buildSocket();
    socket._setPrimitives([renamingPrimitive]);
    socket.setDebug(true);

    const captured: unknown[][] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push([...args]);
    };
    socket.send('action', { id: 1 });
    console.log = origLog;

    const dropCalls = captured.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes('not sent')),
    );
    expect(dropCalls.length).toBeGreaterThan(0);

    const dropLine = dropCalls[0]!.join(' ');
    expect(dropLine).toContain('renamed-action');
    expect(dropLine).not.toContain("send('action')");
  });
});
