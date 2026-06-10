import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { channels } from '~/primitives/channels/channels.ts';
import { namespaces } from '~/primitives/namespaces/namespaces.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrimitiveRuntime, WireMessage } from '~/internal/runtime.ts';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

interface TestContract {
  incoming: { response: { data: string } };
  outgoing: { action: { id: number }; update: { value: string } };
  namespaces: { chat: { outgoing: { action: { id: number } } } };
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
): WSKitSocket {
  // The test reaches into internal members, so it works against the class type.
  return client<TestContract>()(connect('wss://test'), ...primitives) as unknown as WSKitSocket;
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function openedSocket<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<TestContract, P>
): { socket: WSKitSocket; ws: MockWebSocket } {
  const socket = buildSocket(...primitives);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

describe('_send: onOutgoing null cancels before buffering fallback', () => {
  it('returns false immediately when onOutgoing cancels — does not queue the message', () => {
    const cancellingPrimitive: PrimitiveRuntime = {
      id: 'canceller',
      onOutgoing() {
        return null;
      },
    };

    // Build with buffering(enabled:true) so a fallback IS registered
    const socket = buildSocket(buffering({ enabled: true }));
    // Inject the cancelling primitive BEFORE the buffering runtime sees the message.
    // We need it at the front of the primitives list.
    const existing = (socket as WSKitSocket)._primitives;
    (socket as WSKitSocket)._setPrimitives([cancellingPrimitive, ...existing]);

    // Socket is NOT connected — buffering fallback would queue if it were reached
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
    const existing = (socket as WSKitSocket)._primitives;
    (socket as WSKitSocket)._setPrimitives([cancellingPrimitive, ...existing]);

    // While disconnected, try to send — the onOutgoing hook cancels it
    socket.send('action', { id: 2 });

    // Now connect
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    // The cancelled message must NOT appear in the wire frames
    const frames = ws.sentFrames();
    expect(frames.some((f) => f.event === 'action')).toBe(false);
  });
});

describe('_send: return value — true when buffered, false when dropped', () => {
  it('returns false (not queued) for a plain namespace.send while disconnected without buffering', () => {
    const socket = client<TestContract>()(connect('wss://test'), namespaces());
    const ns = socket.namespace('chat');
    expect(socket.getState()).toBe('closed');

    const result = ns.send('action', { id: 1 });

    expect(result).toBe(false);
  });

  it('a dropped scoped send is not replayed on the next connect', () => {
    const socket = client<TestContract>()(connect('wss://test'), namespaces());
    const ns = socket.namespace('chat');
    ns.send('action', { id: 3 });

    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const frames = ws.sentFrames();
    expect(frames.some((f) => f.event === 'action')).toBe(false);
  });

  it('channel.send throws ChannelNotSubscribed before reaching _send when unsubscribed', () => {
    // Channel enforces subscription at the messaging level — the _send false-return
    // path is unreachable for channels without a prior subscribe(). This is the
    // actual current behavior: the guard throws, not returns false.
    const socket = client<TestContract>()(connect('wss://test'), channels());
    const ch = socket.channel('room');
    expect(socket.getState()).toBe('closed');

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
    // Build the socket (state = 'closed', ws = null)
    const socket = buildSocket();
    const before = MockWebSocket.instances.length;

    socket._rawSend({ event: 'ping', payload: {} });

    // No new socket, nothing sent
    expect(MockWebSocket.instances.length).toBe(before);
  });

  it('does not throw when called with no ws', () => {
    const socket = buildSocket();
    expect(() => socket._rawSend({ event: 'test', payload: {} })).not.toThrow();
  });

  it('drops the frame when called after disconnect (ws nulled out)', () => {
    const { socket, ws } = openedSocket();
    socket.disconnect();

    // ws is now null and state is 'closed'
    const framesBefore = ws.sent.length;
    socket._rawSend({ event: 'late', payload: {} });

    expect(ws.sent.length).toBe(framesBefore);
  });

  it('drops a frame sent via helpers.rawSend before the socket opens', () => {
    // A primitive that tries to rawSend in setup (before open)
    let rawSendRef: ((m: WireMessage) => void) | null = null;
    const spy: PrimitiveRuntime = {
      id: 'raw-spy',
    };

    const socket = buildSocket();
    socket._setPrimitives([spy]);

    // Grab the helpers' rawSend function and call it before connecting
    rawSendRef = (m: WireMessage) => socket._rawSend(m);

    // No ws yet — should silently drop
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
    expect(ws.sentFrames()).toContainEqual({ event: 'direct', payload: { x: 1 } });
  });
});
