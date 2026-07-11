import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { plugin } from '~/plugins/plugins.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { serverRequest } from '~/primitives/server-request/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface AppContract {
  incoming: { welcome: { name: string } };
}

interface ChatWire {
  incoming: { message: { text: string } };
  outgoing: { typing: { on: boolean } };
  requests: { 'send-message': { payload: { text: string }; response: { id: string } } };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function build<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<AppContract, P>
) {
  const socket = client<AppContract>()(connect('wss://test'), ...primitives);
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

describe('plugin() registration and API', () => {
  it('exposes the API through Plugin.use, built once and reused', () => {
    let builds = 0;
    const Counter = plugin<{}, { count: () => number }>({
      id: 'acme:counter',
      setup() {
        builds += 1;
        let n = 0;
        return { api: () => ({ count: () => (n += 1) }) };
      },
    });

    const { socket } = build(Counter());
    const first = Counter.use(socket);
    const second = Counter.use(socket);

    expect(first).toBe(second); // same instance
    expect(builds).toBe(1); // setup ran once
    expect(first.count()).toBe(1);
    expect(second.count()).toBe(2); // shared state
  });

  it('throws when a plugin is registered twice (its id owns a namespace)', () => {
    const Chat = plugin({ id: 'acme:chat', setup: () => ({}) });
    expect(() => client<AppContract>()(connect('wss://test'), Chat(), Chat())).toThrow(
      /registered more than once/,
    );
  });

  it('throws at build when a declared dependency is missing', () => {
    const Chat = plugin<ChatWire>({
      id: 'acme:chat',
      dependencies: [requestResponse],
      setup: () => ({}),
    });
    expect(() => client<AppContract>()(connect('wss://test'), Chat())).toThrow(
      /requires requestResponse/,
    );
  });
});

describe('scoped receive — on()', () => {
  it('delivers a namespaced server frame to a bare-name handler', () => {
    const seen: { text: string }[] = [];
    const Chat = plugin<ChatWire>({
      id: 'acme:chat',
      setup(socket) {
        socket.on('message', (m) => seen.push(m));
        return {};
      },
    });

    const { ws } = build(Chat());
    ws.emit({ event: '__acme:chat::message', payload: { text: 'hi' } });

    expect(seen).toEqual([{ text: 'hi' }]);
  });

  it('owns its whole namespace — the app never sees a plugin frame', () => {
    const appSaw = vi.fn();
    const Chat = plugin<ChatWire>({
      id: 'acme:chat',
      setup(socket) {
        socket.on('message', () => {});
        return {};
      },
    });

    const { socket, ws } = build(Chat());
    // A raw app listener for the plugin's wire name (not typed at the top level).
    (socket as unknown as { on(event: string, handler: () => void): void }).on(
      '__acme:chat::message',
      appSaw,
    );

    ws.emit({ event: '__acme:chat::message', payload: { text: 'hi' } });

    expect(appSaw).not.toHaveBeenCalled();
  });

  it('leaves another plugin id and plain app frames alone', () => {
    const chatSaw = vi.fn();
    const Chat = plugin<ChatWire>({
      id: 'acme:chat',
      setup(socket) {
        socket.on('message', chatSaw);
        return {};
      },
    });
    const appSaw = vi.fn();

    const { socket, ws } = build(Chat());
    socket.on('welcome', appSaw);

    ws.emit({ event: 'welcome', payload: { name: 'alice' } });
    ws.emit({ event: '__other:plugin::message', payload: { text: 'x' } });

    expect(appSaw).toHaveBeenCalledWith({ name: 'alice' });
    expect(chatSaw).not.toHaveBeenCalled();
  });

  it('receives namespaced ping/pong events without confusing them for the heartbeat', () => {
    const seen: string[] = [];
    const Heartbeat = plugin<{ incoming: { ping: {}; pong: {} } }>({
      id: 'acme:hb',
      setup(socket) {
        socket.on('ping', () => seen.push('ping'));
        socket.on('pong', () => seen.push('pong'));
        return {};
      },
    });

    const { ws } = build(Heartbeat());
    // Bare `ping`/`pong` are the heartbeat control frames, but under a namespace
    // they are ordinary plugin events — the `::` keeps them apart.
    ws.emit({ event: '__acme:hb::ping', payload: {} });
    ws.emit({ event: '__acme:hb::pong', payload: {} });

    expect(seen).toEqual(['ping', 'pong']);
  });

  it('stops delivering after the returned unsubscribe is called', () => {
    const seen: { text: string }[] = [];
    const Chat = plugin<ChatWire, { off: () => void }>({
      id: 'acme:chat',
      setup(socket) {
        const off = socket.on('message', (m) => seen.push(m));
        return { api: () => ({ off }) };
      },
    });

    const { socket, ws } = build(Chat());
    ws.emit({ event: '__acme:chat::message', payload: { text: 'one' } });
    Chat.use(socket).off();
    ws.emit({ event: '__acme:chat::message', payload: { text: 'two' } });

    expect(seen).toEqual([{ text: 'one' }]);
  });
});

describe('scoped send — send() and request()', () => {
  it('send() prefixes the event with the plugin namespace on the wire', () => {
    const Chat = plugin<ChatWire, { startTyping: () => boolean }>({
      id: 'acme:chat',
      setup(socket) {
        return { api: () => ({ startTyping: () => socket.send('typing', { on: true }) }) };
      },
    });

    const { socket, ws } = build(Chat());
    Chat.use(socket).startTyping();

    const frame = ws.sentFrames().find((f) => f.event === '__acme:chat::typing');
    expect(frame).toBeDefined();
    expect(frame.payload).toEqual({ on: true });
  });

  it('request() prefixes the event and resolves with the reply', async () => {
    const Chat = plugin<ChatWire, { send: (text: string) => Promise<{ id: string }> }>({
      id: 'acme:chat',
      dependencies: [requestResponse],
      setup(socket) {
        return {
          api: () => ({ send: (text: string) => socket.request('send-message', { text }) }),
        };
      },
    });

    const { socket, ws } = build(requestResponse(), Chat());
    const pending = Chat.use(socket).send('hello');

    const sent = ws.sentFrames().find((f) => f.event === '__acme:chat::send-message');
    expect(sent).toBeDefined();
    expect(sent.payload).toEqual({ text: 'hello' });

    const correlationId = sent.__wskit.correlationId as string;
    ws.emit({
      event: '__acme:chat::send-message',
      payload: { id: 'm1' },
      __wskit: { correlationId },
    });

    await expect(pending).resolves.toEqual({ id: 'm1' });
  });
});

interface FeedWire {
  streams: { feed: { payload: { from: number }; chunk: { row: number } } };
  serverRequests: { ping: { payload: { at: number }; response: { pong: boolean } } };
}

describe('scoped stream and onRequest', () => {
  it('stream() prefixes the trigger event on the wire', async () => {
    const Feed = plugin<FeedWire, { start: () => Promise<unknown> }>({
      id: 'acme:feed',
      dependencies: [stream],
      setup(socket) {
        return { api: () => ({ start: () => socket.stream('feed', { from: 0 }) }) };
      },
    });

    const { socket, ws } = build(stream(), Feed());
    void Feed.use(socket).start();

    await expect
      .poll(() => ws.sentFrames().some((f) => f.event === '__acme:feed::feed'))
      .toBe(true);
  });

  it('onRequest() answers a namespaced server request', async () => {
    const Feed = plugin<FeedWire>({
      id: 'acme:feed',
      dependencies: [serverRequest],
      setup(socket) {
        socket.onRequest('ping', () => ({ pong: true }));
        return {};
      },
    });

    const { ws } = build(serverRequest(), Feed());
    ws.emit({
      event: '__acme:feed::ping',
      payload: { at: 1 },
      __wskit: { correlationId: 'p1', source: 'server' },
    });

    await expect
      .poll(() => ws.sentFrames().find((f) => f.__wskit?.correlationId === 'p1')?.payload)
      .toEqual({ pong: true });
  });
});

describe('generic taps and lifecycle', () => {
  it('onIncoming sees every frame, including other namespaces', () => {
    const events: string[] = [];
    const Watcher = plugin({
      id: 'acme:watcher',
      setup(socket) {
        socket.onIncoming((frame) => {
          events.push(frame.event);
          return frame;
        });
        return {};
      },
    });

    const { ws } = build(Watcher());
    ws.emit({ event: 'welcome', payload: { name: 'a' } });
    ws.emit({ event: '__other:plugin::ping', payload: {} });

    expect(events).toContain('welcome');
    expect(events).toContain('__other:plugin::ping');
  });

  it('onOpen frames are sent on connect', () => {
    const Greeter = plugin({
      id: 'acme:greeter',
      setup(socket) {
        socket.onOpen(() => [{ event: 'hello', payload: { v: 1 } }]);
        return {};
      },
    });

    const { ws } = build(Greeter());
    expect(ws.sentFrames().some((f) => f.event === 'hello')).toBe(true);
  });

  it('reports a throwing handler and keeps the pipeline alive', () => {
    const errors: unknown[] = [];
    const later = vi.fn();
    const Chat = plugin<ChatWire>({
      id: 'acme:chat',
      setup(socket) {
        socket.on('message', () => {
          throw new Error('boom');
        });
        return {};
      },
    });
    const { socket, ws } = build(Chat());
    socket.onError((error) => errors.push(error));
    socket.on('welcome', later);

    ws.emit({ event: '__acme:chat::message', payload: { text: 'x' } });
    ws.emit({ event: 'welcome', payload: { name: 'a' } });

    // The throw was reported, and the socket kept working.
    expect(errors).toHaveLength(1);
    expect(later).toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('runs on an intentional disconnect', () => {
    const dispose = vi.fn();
    const Chat = plugin({ id: 'acme:chat', setup: () => ({ dispose }) });

    const { socket } = build(Chat());
    socket.disconnect();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not run on a transient drop that may reconnect', () => {
    const dispose = vi.fn();
    const Chat = plugin({ id: 'acme:chat', setup: () => ({ dispose }) });

    const { ws } = build(Chat());
    ws.serverClose(1006, 'network');

    expect(dispose).not.toHaveBeenCalled();
  });

  it('runs at most once', () => {
    const dispose = vi.fn();
    const Chat = plugin({ id: 'acme:chat', setup: () => ({ dispose }) });

    const { socket } = build(Chat());
    socket.disconnect();
    socket.disconnect();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('guards', () => {
  it('throws when a hook is registered twice', () => {
    const Chat = plugin({
      id: 'acme:chat',
      setup(socket) {
        socket.onIncoming((m) => m);
        socket.onIncoming((m) => m);
        return {};
      },
    });
    expect(() => build(Chat())).toThrow(/onIncoming\(\) twice/);
  });
});
