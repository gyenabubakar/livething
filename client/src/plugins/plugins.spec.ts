import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { environment } from '~/environment.ts';
import { observeHost, plugin } from '~/plugins/plugins.ts';
import { channels } from '~/primitives/channels/channels.ts';
import { platform } from '~/primitives/platform.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { serverRequest } from '~/primitives/server-request/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

// A host contract shaped like `InferClient` output: the app's own `welcome`, plus
// every plugin namespace these tests register. A plugin now requires its namespace
// to be present in the socket's contract, so the shared build() contract carries
// all of them (a superset satisfies each plugin's own requirement).
interface AppContract {
  incoming: {
    welcome: { name: string };
    '__acme:chat::message': { text: string };
    '__acme:hb::ping': {};
    '__acme:hb::pong': {};
  };
  outgoing: {
    '__acme:chat::typing': { on: boolean };
  };
  requests: {
    '__acme:chat::send-message': { payload: { text: string }; response: { id: string } };
  };
  serverRequests: {
    '__acme:feed::ping': { payload: { at: number }; response: { pong: boolean } };
  };
  streams: {
    '__acme:feed::feed': { payload: { from: number }; chunk: { row: number } };
  };
  channels: {
    '__acme:chat::thread': { addressing: 'dynamic'; incoming: { post: { text: string } } };
  };
  errors: {
    '__acme:chat::room-full': { limit: number };
  };
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
  // Inside this generic helper the claimed-namespace strip stays deferred on the
  // abstract P, so connect() isn't visible on the computed type; it always exists
  // on the base socket. Call sites use concrete primitives and see the full type.
  (socket as { connect(): void }).connect();
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
    const Counter = plugin<{}, { count: () => number }>()({
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
    const Chat = plugin()({ id: 'acme:chat', setup: () => ({}) });
    expect(() => client<AppContract>()(connect('wss://test'), Chat(), Chat())).toThrow(
      /registered more than once/,
    );
  });

  it('throws at build when a declared dependency is missing', () => {
    const Chat = plugin<ChatWire>()({
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
    const Chat = plugin<ChatWire>()({
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
    const Chat = plugin<ChatWire>()({
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
    const Chat = plugin<ChatWire>()({
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
    const Heartbeat = plugin<{ incoming: { ping: {}; pong: {} } }>()({
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
    const Chat = plugin<ChatWire, { off: () => void }>()({
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
    const Chat = plugin<ChatWire, { startTyping: () => boolean }>()({
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
    const Chat = plugin<ChatWire, { send: (text: string) => Promise<{ id: string }> }>()({
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
    const Feed = plugin<FeedWire, { start: () => Promise<unknown> }>()({
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
    const Feed = plugin<FeedWire>()({
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

interface ThreadWire {
  channels: { thread: { addressing: 'dynamic'; incoming: { post: { text: string } } } };
}

describe('scoped channels — dynamic families', () => {
  it('round-trips a family member under the namespace, surfacing plain names', async () => {
    const posts: string[] = [];
    const subscribed: string[] = [];
    const Chat = plugin<ThreadWire, { open: () => Promise<void>; rooms: () => string[] }>()({
      id: 'acme:chat',
      dependencies: [channels],
      setup(socket) {
        const family = socket.channel.family('thread');
        family.onSubscribed((name) => subscribed.push(name));
        const one = socket.channel('thread', 'thread:1');
        one.on('post', (m) => posts.push(m.text));
        return { api: () => ({ open: () => one.subscribe(), rooms: () => family.list() }) };
      },
    });

    const { socket, ws } = build(channels(), Chat());
    const api = Chat.use(socket);
    const pending = api.open();

    // The family KEY carries the plugin namespace; the concrete member name is a
    // runtime value matched against the family pattern, so it stays as written.
    const sub = ws.sentFrames().find((f) => f.event === '__subscribe__');
    expect(sub?.__wskit?.channelFamily).toBe('__acme:chat::thread');
    expect(sub?.__wskit?.channel).toBe('thread:1');

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'thread:1', channelFamily: '__acme:chat::thread' },
    });
    await pending;

    // The server sends a plugin channel's child event namespaced; the namespace
    // sits on the family key, so it's stripped back to the bare `post`.
    ws.emit({
      event: '__acme:chat::post',
      payload: { text: 'hi' },
      __wskit: { channel: 'thread:1', channelFamily: '__acme:chat::thread' },
    });

    expect(posts).toEqual(['hi']);
    expect(subscribed).toEqual(['thread:1']);
    expect(api.rooms()).toEqual(['thread:1']);
  });
});

describe('scoped errors — onError()', () => {
  it('delivers a namespaced unsolicited error to a typed handler', () => {
    const seen: { code: string; detail: unknown }[] = [];
    const Chat = plugin<{ errors: { 'room-full': { limit: number } } }>()({
      id: 'acme:chat',
      setup(socket) {
        socket.onError((e) => seen.push(e));
        return {};
      },
    });

    const { ws } = build(Chat());
    ws.emit({
      event: '__error__',
      payload: { code: '__acme:chat::room-full', detail: { limit: 5 } },
    });

    // Plain code, typed detail — the `__acme:chat::` prefix is stripped.
    expect(seen).toEqual([{ code: 'room-full', detail: { limit: 5 } }]);
  });

  it('bubbles to the app onError when the plugin registered no handler', () => {
    const appErrors: unknown[] = [];
    const Chat = plugin<{ errors: { 'room-full': { limit: number } } }>()({
      id: 'acme:chat',
      setup: () => ({}),
    });

    const { socket, ws } = build(Chat());
    socket.onError((e) => appErrors.push(e));
    ws.emit({
      event: '__error__',
      payload: { code: '__acme:chat::room-full', detail: { limit: 5 } },
    });

    expect(appErrors).toHaveLength(1);
  });
});

describe('generic taps and lifecycle', () => {
  it('a host-observing plugin sees every frame, including other namespaces', () => {
    const events: string[] = [];
    const Watcher = plugin()({
      id: 'acme:watcher',
      observesHostTraffic: true,
      setup(socket) {
        socket.onIncoming((frame) => {
          events.push(frame.event);
          return frame;
        });
        return {};
      },
    });

    const { ws } = build(observeHost(Watcher()));
    ws.emit({ event: 'welcome', payload: { name: 'a' } });
    ws.emit({ event: '__other:plugin::ping', payload: {} });

    expect(events).toContain('welcome');
    expect(events).toContain('__other:plugin::ping');
  });

  it('a plain plugin only taps its own namespace', () => {
    const events: string[] = [];
    const Watcher = plugin()({
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
    ws.emit({ event: '__acme:watcher::tick', payload: {} });

    // Only its own frame; the app's and another plugin's are invisible to it.
    expect(events).toEqual(['__acme:watcher::tick']);
  });

  it('onOpen frames are sent on connect, stamped with the plugin namespace', () => {
    const Greeter = plugin()({
      id: 'acme:greeter',
      setup(socket) {
        socket.onOpen(() => [{ event: 'hello', payload: { v: 1 } }]);
        return {};
      },
    });

    const { ws } = build(Greeter());
    // Plain name in, `__acme:greeter::hello` out — same scoping as send().
    expect(ws.sentFrames().some((f) => f.event === 'hello')).toBe(false);
    const frame = ws.sentFrames().find((f) => f.event === '__acme:greeter::hello');
    expect(frame?.payload).toEqual({ v: 1 });
  });

  it('reports a throwing handler and keeps the pipeline alive', () => {
    const errors: unknown[] = [];
    const later = vi.fn();
    const Chat = plugin<ChatWire>()({
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
    const Chat = plugin()({ id: 'acme:chat', setup: () => ({ dispose }) });

    const { socket } = build(Chat());
    socket.disconnect();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not run on a drop that will reconnect', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const Chat = plugin()({ id: 'acme:chat', setup: () => ({ dispose }) });

    const { socket, ws } = build(Chat(), reconnection());
    ws.serverClose(1006, 'network');
    expect(socket.state.get()).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('runs on a terminal drop when nothing will reconnect', async () => {
    const dispose = vi.fn();
    const Chat = plugin()({ id: 'acme:chat', setup: () => ({ dispose }) });

    const { socket, ws } = build(Chat());
    ws.serverClose(1006, 'network');
    expect(socket.state.get()).toBe('closed');

    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('runs at most once', () => {
    const dispose = vi.fn();
    const Chat = plugin()({ id: 'acme:chat', setup: () => ({ dispose }) });

    const { socket } = build(Chat());
    socket.disconnect();
    socket.disconnect();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not run on a platform suspend, which resumes the same session', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const onClose = vi.fn();
    const Chat = plugin()({
      id: 'acme:chat',
      setup(socket) {
        socket.onClose((_code, _reason, suspended) => onClose(suspended));
        return { dispose };
      },
    });

    const control: { setVisible?: (visible: boolean) => void } = {};
    const env = environment({
      onVisibilityChange(cb) {
        control.setVisible = cb;
        return () => {};
      },
      onNetworkChange() {
        return () => {};
      },
    });

    const { socket } = build(Chat(), platform({ environment: env, backgroundDisconnectMs: 1000 }));
    control.setVisible?.(false);
    vi.advanceTimersByTime(1000); // backgrounded long enough → the socket suspends
    await Promise.resolve();

    // A suspend settles on 'closed' but is meant to resume, so the plugin lives on.
    expect(socket.state.get()).toBe('closed');
    expect(dispose).not.toHaveBeenCalled();
    // onClose still fires, flagged as a suspend so a handler can tell it apart.
    expect(onClose).toHaveBeenCalledWith(true);
    vi.useRealTimers();
  });
});

describe('guards', () => {
  it('throws when a hook is registered twice', () => {
    const Chat = plugin()({
      id: 'acme:chat',
      setup(socket) {
        socket.onIncoming((m) => m);
        socket.onIncoming((m) => m);
        return {};
      },
    });
    expect(() => build(Chat())).toThrow(/onIncoming\(\) twice/);
  });

  it('throws when the id contains the :: delimiter', () => {
    // `::` separates id from name on the wire, so an id holding it would let one
    // plugin's prefix swallow another's frames.
    expect(() => plugin()({ id: 'acme::chat', setup: () => ({}) })).toThrow(/must not contain/);
  });

  it('throws a clear error when a used verb’s primitive is not registered', () => {
    // The contract types `request`, but neither the plugin's dependencies nor the
    // app registered requestResponse — calling it names what to add.
    const Chat = plugin<ChatWire, { go: () => Promise<{ id: string }> }>()({
      id: 'acme:chat',
      setup(socket) {
        return { api: () => ({ go: () => socket.request('send-message', { text: 'x' }) }) };
      },
    });

    const { socket } = build(Chat());
    expect(() => Chat.use(socket).go()).toThrow(/requestResponse primitive isn't registered/);
  });
});

describe('scoped tools', () => {
  it('exposes the reactive connection-state store', () => {
    const seen: string[] = [];
    const Watcher = plugin()({
      id: 'acme:watcher',
      setup(socket) {
        socket.state.subscribe(() => seen.push(socket.state.get()));
        return {};
      },
    });

    const { socket } = build(Watcher());
    socket.disconnect();

    // The plugin saw the live transitions through to the final close.
    expect(seen).toContain('open');
    expect(seen.at(-1)).toBe('closed');
  });
});
