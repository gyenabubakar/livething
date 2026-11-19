import { LiveThingError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { environment } from '~/environment.ts';
import { plugin } from '~/plugins/plugins.ts';
import { channels } from '~/primitives/channels/channels.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { platform } from '~/primitives/platform.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { serverRequests } from '~/primitives/server-requests/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { StreamHandle } from '~/types.ts';

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
    '__acme:hb::ping': {};
    '__acme:hb::pong': {};
  };
  clientRequests: {
    '__acme:chat::send-message': { payload: { text: string }; response: { id: string } };
  };
  serverRequests: {
    '__acme:feed::ping': { payload: { at: number }; response: { pong: boolean } };
  };
  streams: {
    '__acme:feed::feed': { payload: { from: number }; chunk: { row: number }; kind: 'persistent' };
  };
  channels: {
    '__acme:chat::room': {
      incoming: { ping: {}; pong: {} };
      outgoing: { ping: {}; pong: {} };
    };
    '__acme:chat::thread': {
      addressing: 'dynamic';
      incoming: { post: { text: string }; ping: {}; pong: {} };
      outgoing: { ping: {}; pong: {} };
    };
  };
  errors: {
    '__acme:chat::room-full': { limit: number };
  };
}

interface ChatWire {
  incoming: { message: { text: string } };
  outgoing: { typing: { on: boolean } };
  clientRequests: { 'send-message': { payload: { text: string }; response: { id: string } } };
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
  vi.useRealTimers();
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
      dependencies: [clientRequests],
      setup: () => ({}),
    });
    // The type already rejects this; the runtime check covers plain JavaScript callers.
    // @ts-expect-error — Chat requires clientRequests()
    expect(() => client<AppContract>()(connect('wss://test'), Chat())).toThrow(
      /requires clientRequests/,
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
  it('allows namespaced ping/pong but rejects empty and non-string plugin events', () => {
    type HeartbeatWire = { outgoing: { ping: {}; pong: {} } };
    type HeartbeatApi = { send: (event: 'ping' | 'pong') => boolean };
    const Heartbeat = plugin<HeartbeatWire, HeartbeatApi>()({
      id: 'acme:hb',
      setup(socket) {
        return { api: () => ({ send: (event) => socket.send(event, {}) }) };
      },
    });

    const { socket, ws } = build(Heartbeat());
    const send = Heartbeat.use(socket).send as unknown as (
      event: unknown,
      payload?: unknown,
    ) => boolean;

    expect(send('ping')).toBe(true);
    expect(send('pong')).toBe(true);
    expect(send('')).toBe(false);
    expect(send(null)).toBe(false);
    expect(ws.sentFrames().map((frame) => frame.event)).toEqual([
      '__acme:hb::ping',
      '__acme:hb::pong',
    ]);
  });

  it('allows ping and pong as plugin-channel events after namespacing', async () => {
    type ChatChannels = {
      channels: {
        room: { incoming: { ping: {}; pong: {} }; outgoing: { ping: {}; pong: {} } };
        thread: {
          addressing: 'dynamic';
          incoming: { ping: {}; pong: {} };
          outgoing: { ping: {}; pong: {} };
        };
      };
    };
    const Chat = plugin<ChatChannels, { rooms: () => unknown }>()({
      id: 'acme:chat',
      dependencies: [channels],
      setup(socket) {
        return {
          api: () => ({
            rooms: () => ({
              static: socket.channel('room'),
              dynamic: socket.channel('thread', 'one'),
            }),
          }),
        };
      },
    });

    const { socket, ws } = build(channels(), Chat());
    const rooms = Chat.use(socket).rooms() as {
      static: {
        subscribe(): Promise<void>;
        send(event: string, payload: unknown): boolean;
      };
      dynamic: {
        subscribe(): Promise<void>;
        send(event: string, payload: unknown): boolean;
      };
    };
    const subscribed = rooms.static.subscribe();
    expect(ws.sentFrames().at(-1)).toMatchObject({
      event: '__subscribe__',
      metadata: { channel: { name: '__acme:chat::room' } },
    });
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: '__acme:chat::room' } },
    });

    await subscribed;

    expect(rooms.static.send('ping', {})).toBe(true);
    expect(rooms.static.send('pong', {})).toBe(true);
    expect(rooms.static.send('', {})).toBe(false);
    expect(rooms.static.send(null as unknown as string, {})).toBe(false);
    expect(
      ws
        .sentFrames()
        .slice(-2)
        .map((frame) => frame.event),
    ).toEqual(['__acme:chat::ping', '__acme:chat::pong']);

    const dynamicSubscribed = rooms.dynamic.subscribe();
    expect(ws.sentFrames().at(-1)).toMatchObject({
      event: '__subscribe__',
      metadata: { channel: { name: 'one', family: '__acme:chat::thread' } },
    });
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: {
        exchange: { source: 'client' },
        channel: { name: 'one', family: '__acme:chat::thread' },
      },
    });
    await dynamicSubscribed;
    expect(rooms.dynamic.send('ping', {})).toBe(true);

    expect(rooms.dynamic.send('pong', {})).toBe(true);
    expect(rooms.dynamic.send('', {})).toBe(false);
    expect(
      ws
        .sentFrames()
        .slice(-2)
        .map((frame) => frame.event),
    ).toEqual(['__acme:chat::ping', '__acme:chat::pong']);
  });

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
      dependencies: [clientRequests],
      setup(socket) {
        return {
          api: () => ({ send: (text: string) => socket.request('send-message', { text }) }),
        };
      },
    });

    const { socket, ws } = build(clientRequests(), Chat());
    const pending = Chat.use(socket).send('hello');

    const sent = ws.sentFrames().find((f) => f.event === '__acme:chat::send-message');
    expect(sent).toBeDefined();
    expect(sent.payload).toEqual({ text: 'hello' });

    const correlationId = sent.metadata.exchange?.id as string;
    ws.emit({
      event: '__acme:chat::send-message',
      payload: { id: 'm1' },
      metadata: { exchange: { id: correlationId } },
    });

    await expect(pending).resolves.toEqual({ id: 'm1' });
  });
});

interface FeedWire {
  streams: { feed: { payload: { from: number }; chunk: { row: number }; kind: 'persistent' } };
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
    const pending = Feed.use(socket).start();

    await expect
      .poll(() => ws.sentFrames().some((f) => f.event === '__acme:feed::feed'))
      .toBe(true);

    socket.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('onRequest() answers a namespaced server request', async () => {
    const Feed = plugin<FeedWire>()({
      id: 'acme:feed',
      dependencies: [serverRequests],
      setup(socket) {
        socket.onRequest('ping', () => ({ pong: true }));
        return {};
      },
    });

    const { ws } = build(serverRequests(), Feed());
    ws.emit({
      event: '__acme:feed::ping',
      payload: { at: 1 },
      metadata: { exchange: { id: 'p1', source: 'server' } },
    });

    await expect
      .poll(() => ws.sentFrames().find((f) => f.metadata?.exchange?.id === 'p1')?.payload)
      .toEqual({ pong: true });
  });

  it('onStream() subscribes under the namespace and routes namespaced broadcast chunks', () => {
    const chunks: [unknown, string][] = [];
    const ends: string[] = [];
    const Feed = plugin<FeedWire>()({
      id: 'acme:feed',
      dependencies: [stream],
      setup(socket) {
        socket.onStream('feed', {
          onChunk: (chunk, id) => chunks.push([chunk, id]),
          onEnd: (id) => ends.push(id),
        });
        return {};
      },
    });

    const { ws } = build(stream(), Feed());
    // The server pushes the broadcast under the plugin's wire name; onStream
    // registered for `__acme:feed::feed`, so the scoped handler sees it.
    ws.emit({
      event: '__acme:feed::feed',
      payload: { row: 1 },
      metadata: { stream: { id: 'bs1', seq: 1 } },
    });
    ws.emit({
      event: '__streamEnd__',
      payload: {},
      metadata: { stream: { id: 'bs1', event: '__acme:feed::feed', seq: 1 } },
    });

    expect(chunks).toEqual([[{ row: 1 }, 'bs1']]);
    expect(ends).toEqual(['bs1']);
  });

  it('continueStream() continues a namespaced durable stream and replays its chunks', async () => {
    const Feed = plugin<FeedWire, { continue: () => StreamHandle<{ row: number }> }>()({
      id: 'acme:feed',
      dependencies: [stream],
      setup(socket) {
        return {
          api: () => ({
            continue: () => socket.continueStream('feed', 'feed-1', { lastKnownSeq: 0 }),
          }),
        };
      },
    });

    const { socket, ws } = build(stream(), Feed());
    const handle = Feed.use(socket).continue();

    // The continue frame is a reserved control frame keyed by streamId; chunks then
    // arrive on the plugin's wire event and replay into the returned handle.
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__continueStream__',
      payload: { lastKnownSeq: 0 },
      metadata: { stream: { id: 'feed-1' } },
    });
    ws.emit({
      event: '__acme:feed::feed',
      payload: { row: 1 },
      metadata: { stream: { id: 'feed-1', seq: 1 } },
    });
    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: 'feed-1' } } });

    const rows: { row: number }[] = [];
    for await (const chunk of handle) rows.push(chunk);
    expect(rows).toEqual([{ row: 1 }]);
  });

  it('a plugin request rejection surfaces the plain error code', async () => {
    const Chat = plugin<
      {
        clientRequests: { 'send-message': { payload: { text: string }; response: { id: string } } };
        errors: { 'room-full': { limit: number } };
      },
      { send: () => Promise<{ id: string }> }
    >()({
      id: 'acme:chat',
      dependencies: [clientRequests],
      setup(socket) {
        return { api: () => ({ send: () => socket.request('send-message', { text: 'hi' }) }) };
      },
    });

    const { socket, ws } = build(clientRequests(), Chat());
    const pending = Chat.use(socket).send();

    const req = ws.sentFrames().find((f) => f.event === '__acme:chat::send-message');
    const correlationId = req?.metadata?.exchange?.id as string;
    // The server sends a plugin error with its namespaced wire code.
    ws.emit({
      event: '__error__',
      payload: { code: '__acme:chat::room-full', detail: { limit: 5 } },
      metadata: { exchange: { id: correlationId } },
    });

    // The plugin author works in plain names, so the rejection carries `room-full`.
    await expect(pending).rejects.toBeInstanceOf(LiveThingError);
    await pending.catch((error: LiveThingError) => {
      expect(error.code).toBe('room-full');
      expect(error.detail).toEqual({ limit: 5 });
    });
  });

  it('a plugin stream error surfaces the plain error code', async () => {
    interface Wire {
      streams: { feed: { payload: { from: number }; chunk: { row: number } } };
      errors: { 'feed-gone': { why: string } };
    }

    interface Host {
      streams: { '__acme:feed::feed': { payload: { from: number }; chunk: { row: number } } };
      errors: { '__acme:feed::feed-gone': { why: string } };
    }

    const Feed = plugin<Wire, { start: () => Promise<StreamHandle<{ row: number }>> }>()({
      id: 'acme:feed',
      dependencies: [stream],
      setup(socket) {
        return {
          api: () => ({ start: () => socket.stream('feed', { from: 0 }, { streamId: 'sc-err' }) }),
        };
      },
    });

    const socket = client<Host>()(connect('wss://test'), stream(), Feed());
    (socket as { connect(): void }).connect();
    const ws = MockWebSocket.last();
    ws.open();

    const starting = Feed.use(socket).start();
    // A stream error before it starts rejects the trigger; the code is namespaced
    // on the wire and must reach the plugin author stripped to `feed-gone`.
    ws.emit({
      event: '__error__',
      payload: { code: '__acme:feed::feed-gone', detail: { why: 'closed' } },
      metadata: { stream: { id: 'sc-err' } },
    });

    await expect(starting).rejects.toBeInstanceOf(LiveThingError);
    await starting.catch((error: LiveThingError) => {
      expect(error.code).toBe('feed-gone');
      expect(error.detail).toEqual({ why: 'closed' });
    });
  });

  it('a plugin stream nudge sends the namespaced event', async () => {
    vi.useFakeTimers();
    interface Wire {
      streams: {
        feed: {
          payload: { from: number };
          chunk: { row: number };
          nudges: { boost: { amount: number } };
        };
      };
    }

    interface Host {
      streams: {
        '__acme:feed::feed': {
          payload: { from: number };
          chunk: { row: number };
          nudges: { boost: { amount: number } };
        };
      };
    }

    const Feed = plugin<
      Wire,
      { start: () => Promise<StreamHandle<{ row: number }, { boost: { amount: number } }>> }
    >()({
      id: 'acme:feed',
      dependencies: [stream],
      setup(socket) {
        return {
          api: () => ({
            start: () => socket.stream('feed', { from: 0 }, { streamId: 'nudge-sc' }),
          }),
        };
      },
    });

    const socket = client<Host>()(connect('wss://test'), stream(), Feed());
    (socket as { connect(): void }).connect();
    const ws = MockWebSocket.last();
    ws.open();

    const starting = Feed.use(socket).start();
    ws.emit({ event: '__streamOk__', payload: {}, metadata: { stream: { id: 'nudge-sc' } } });
    const handle = await starting;

    const timersBeforeNudge = vi.getTimerCount();
    const pending = handle.nudge('boost', { amount: 2 });
    expect(vi.getTimerCount()).toBe(timersBeforeNudge + 1);

    // The nudge event carries the plugin's `__acme:feed::` prefix, like its trigger,
    // so the server finds it among the stream's registered nudges.
    const frame = ws.sentFrames().at(-1);
    expect(frame?.event).toBe('__acme:feed::boost');
    const streamNudgeId = frame?.metadata?.stream?.nudgeId;
    expect(frame?.metadata).toEqual({
      stream: { id: 'nudge-sc', nudgeId: expect.any(String) },
    });

    ws.emit({
      event: '__nudgeOk__',
      payload: {},
      metadata: { stream: { id: 'nudge-sc', nudgeId: streamNudgeId } },
    });
    await expect(pending).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(timersBeforeNudge);

    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: 'nudge-sc' } } });
    expect(handle.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    socket.disconnect();
    expect(vi.getTimerCount()).toBe(0);
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
    expect(sub?.metadata?.channel?.family).toBe('__acme:chat::thread');
    expect(sub?.metadata?.channel?.name).toBe('thread:1');

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: {
        exchange: { source: 'client' },
        channel: { name: 'thread:1', family: '__acme:chat::thread' },
      },
    });
    await pending;

    // The server sends a plugin channel's child event namespaced; the namespace
    // sits on the family key, so it's stripped back to the bare `post`.
    ws.emit({
      event: '__acme:chat::post',
      payload: { text: 'hi' },
      metadata: { channel: { name: 'thread:1', family: '__acme:chat::thread' } },
    });

    expect(posts).toEqual(['hi']);
    expect(subscribed).toEqual(['thread:1']);
    expect(api.rooms()).toEqual(['thread:1']);
  });

  it('namespaces a plugin channel outgoing child events (static and dynamic)', async () => {
    interface Wire {
      channels: {
        room: { outgoing: { chat: { text: string } }; incoming: { said: { text: string } } };
        thread: {
          addressing: 'dynamic';
          outgoing: { say: { text: string } };
          incoming: { posted: { text: string } };
        };
      };
    }

    interface Host {
      channels: {
        '__acme:chat::room': {
          outgoing: { chat: { text: string } };
          incoming: { said: { text: string } };
        };
        '__acme:chat::thread': {
          addressing: 'dynamic';
          outgoing: { say: { text: string } };
          incoming: { posted: { text: string } };
        };
      };
    }

    type ChatApi = {
      joinRoom: () => Promise<void>;
      chat: (text: string) => void;
      joinThread: () => Promise<void>;
      say: (text: string) => void;
    };

    const Chat = plugin<Wire, ChatApi>()({
      id: 'acme:chat',
      dependencies: [channels],
      setup(socket) {
        const room = socket.channel('room');
        const thread = socket.channel('thread', 'thread:1');
        return {
          api: () => ({
            joinRoom: () => room.subscribe(),
            chat: (text) => void room.send('chat', { text }),
            joinThread: () => thread.subscribe(),
            say: (text) => void thread.send('say', { text }),
          }),
        };
      },
    });

    const socket = client<Host>()(connect('wss://test'), channels(), Chat());
    (socket as { connect(): void }).connect();
    const ws = MockWebSocket.last();
    ws.open();
    const api = Chat.use(socket);

    const roomSub = api.joinRoom();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: '__acme:chat::room' } },
    });
    await roomSub;

    const threadSub = api.joinThread();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: {
        exchange: { source: 'client' },
        channel: { name: 'thread:1', family: '__acme:chat::thread' },
      },
    });
    await threadSub;

    api.chat('hi');
    api.say('yo');

    // Static channel: the child event is namespaced, matching what the server
    // registers, and the channel name is namespaced in the marker.
    const chat = ws.sentFrames().find((f) => (f.payload as { text?: string })?.text === 'hi');
    expect(chat?.event).toBe('__acme:chat::chat');
    expect(chat?.metadata?.channel?.name).toBe('__acme:chat::room');

    // Dynamic member: child event namespaced, family key namespaced, instance plain.
    const say = ws.sentFrames().find((f) => (f.payload as { text?: string })?.text === 'yo');
    expect(say?.event).toBe('__acme:chat::say');
    expect(say?.metadata).toMatchObject({
      channel: { name: 'thread:1', family: '__acme:chat::thread' },
    });
  });

  it('a plugin channel subscribe rejection surfaces the plain error code', async () => {
    interface Wire {
      channels: { room: { incoming: { joined: { who: string } } } };
      errors: { 'room-locked': { reason: string } };
    }

    interface Host {
      channels: { '__acme:chat::room': { incoming: { joined: { who: string } } } };
      errors: { '__acme:chat::room-locked': { reason: string } };
    }

    const Chat = plugin<Wire, { join: () => Promise<void> }>()({
      id: 'acme:chat',
      dependencies: [channels],
      setup(socket) {
        const room = socket.channel('room');
        return { api: () => ({ join: () => room.subscribe() }) };
      },
    });

    const socket = client<Host>()(connect('wss://test'), channels(), Chat());
    (socket as { connect(): void }).connect();
    const ws = MockWebSocket.last();
    ws.open();
    const pending = Chat.use(socket).join();

    // The server rejects the subscribe with its namespaced error code.
    ws.emit({
      event: '__error__',
      payload: { code: '__acme:chat::room-locked', detail: { reason: 'full' } },
      metadata: { channel: { name: '__acme:chat::room' } },
    });

    // The plugin author works in plain names, so the rejection carries `room-locked`.
    await expect(pending).rejects.toBeInstanceOf(LiveThingError);
    await pending.catch((error: LiveThingError) => {
      expect(error.code).toBe('room-locked');
      expect(error.detail).toEqual({ reason: 'full' });
    });
  });
});

describe('scoped channels — missing receipt primitives', () => {
  it('throws a clear error instead of exposing undefined receipt methods', () => {
    interface ReceiptWire {
      channels: {
        room: {
          inbox: true;
          readReceipts: true;
          incoming: { message: { text: string } };
        };
      };
    }

    interface ReceiptHost {
      channels: {
        '__acme:receipts::room': {
          inbox: true;
          readReceipts: true;
          incoming: { message: { text: string } };
        };
      };
    }

    const Receipts = plugin<ReceiptWire>()({
      id: 'acme:receipts',
      dependencies: [channels],
      setup(socket) {
        const room = socket.channel('room');
        return { api: () => ({ room }) };
      },
    });

    const socket = client<ReceiptHost>()(connect('wss://test'), channels(), Receipts());
    (socket as { connect(): void }).connect();
    MockWebSocket.last().open();
    const room = Receipts.use(socket).room;

    expect(() => room.receivers.get()).toThrow(/inbox\(\).*not registered/);
    expect(() => room.markAsRead()).toThrow(/readReceipts\(\).*not registered/);
  });

  it('throws a clear error for channel.awareness when awareness() is not registered', () => {
    interface DocsWire {
      channels: { room: { awareness: { typing: boolean }; incoming: {} } };
    }

    const Docs = plugin<DocsWire>()({
      id: 'acme:docs',
      dependencies: [channels],
      setup(socket) {
        const room = socket.channel('room');
        return { api: () => ({ room }) };
      },
    });

    const socket = client<{ channels: { '__acme:docs::room': DocsWire['channels']['room'] } }>()(
      connect('wss://test'),
      channels(),
      Docs(),
    );
    const room = Docs.use(socket).room;

    expect(() => room.awareness.set({ typing: true })).toThrow(/awareness\(\).*not registered/);
  });

  it("does not apply one plugin's missing receipt throwers to other scopes", () => {
    interface ReceiptWire {
      channels: {
        room: {
          inbox: true;
          readReceipts: true;
          incoming: { message: { text: string } };
        };
      };
    }

    interface ReceiptHost {
      channels: {
        '__acme:a::room': ReceiptWire['channels']['room'];
        '__acme:b::room': ReceiptWire['channels']['room'];
        appRoom: { incoming: { message: { text: string } } };
      };
    }

    const A = plugin<ReceiptWire>()({
      id: 'acme:a',
      dependencies: [channels],
      setup(socket) {
        const room = socket.channel('room');
        return { api: () => ({ room }) };
      },
    });
    const B = plugin<ReceiptWire>()({
      id: 'acme:b',
      dependencies: [channels],
      setup(socket) {
        const room = socket.channel('room');
        return { api: () => ({ room }) };
      },
    });

    const socket = client<ReceiptHost>()(connect('wss://test'), channels(), A(), B());
    (socket as { connect(): void }).connect();
    MockWebSocket.last().open();

    const aRoom = A.use(socket).room;
    const bRoom = B.use(socket).room;
    const appRoom = socket.channel('appRoom');

    expect(() => aRoom.receivers.get()).toThrow(/acme:a/);
    expect(() => bRoom.receivers.get()).toThrow(/acme:b/);
    expect((appRoom as unknown as { receivers?: unknown }).receivers).toBeUndefined();
  });
});

describe('scoped errors — onServerError()', () => {
  it('does not expose the removed plugin onError alias', () => {
    let pluginSocket: object | undefined;
    const Chat = plugin<{ errors: { 'room-full': { limit: number } } }>()({
      id: 'acme:chat',
      setup(socket) {
        pluginSocket = socket;
        return {};
      },
    });

    build(Chat());

    expect(pluginSocket).not.toHaveProperty('onError');
    expect(pluginSocket).toHaveProperty('onServerError');
  });

  it('delivers a namespaced unsolicited error as a real LiveThingError with the plain code', () => {
    const seen: LiveThingError[] = [];
    const Chat = plugin<{ errors: { 'room-full': { limit: number } } }>()({
      id: 'acme:chat',
      setup(socket) {
        socket.onServerError((e) => seen.push(e));
        return {};
      },
    });

    const { ws } = build(Chat());
    ws.emit({
      event: '__error__',
      payload: { code: '__acme:chat::room-full', detail: { limit: 5 } },
    });

    // A real LiveThingError instance (so `.matches()` / `instanceof` work), with the
    // `__acme:chat::` prefix stripped and the typed detail intact.
    expect(seen).toHaveLength(1);
    const [error] = seen;
    expect(error).toBeInstanceOf(LiveThingError);
    expect(error?.code).toBe('room-full');
    expect(error?.detail).toEqual({ limit: 5 });
  });

  it('surfaces an unhandled namespaced error to the app onServerError, keeping the namespaced code', () => {
    const appErrors: unknown[] = [];
    const Chat = plugin<{ errors: { 'room-full': { limit: number } } }>()({
      id: 'acme:chat',
      setup: () => ({}),
    });

    const { socket, ws } = build(Chat());
    socket.onServerError((e) => appErrors.push(e));
    ws.emit({
      event: '__error__',
      payload: { code: '__acme:chat::room-full', detail: { limit: 5 } },
    });

    // The plugin owns the frame, so with no scoped handler it goes to the app's
    // onServerError catch-all as a LiveThingError — the namespaced code keeps it unambiguous.
    expect(appErrors).toHaveLength(1);
    expect(appErrors[0]).toBeInstanceOf(LiveThingError);
    expect((appErrors[0] as LiveThingError).code).toBe('__acme:chat::room-full');
  });

  it('passes a namespaced error to the host when only a non-matching plugin code is registered', () => {
    const pluginErrors: LiveThingError[] = [];
    const hostErrors: LiveThingError[] = [];
    const Chat = plugin<{ errors: { 'room-full': { limit: number } } }>()({
      id: 'acme:chat',
      setup(socket) {
        socket.onServerError('room-full', (error) => pluginErrors.push(error));
        return {};
      },
    });

    const { socket, ws } = build(Chat());
    socket.onServerError((error) => hostErrors.push(error));
    ws.emit({
      event: '__error__',
      payload: { code: '__acme:chat::other', detail: { reason: 'new-server-code' } },
    });

    expect(pluginErrors).toHaveLength(0);
    expect(hostErrors).toHaveLength(1);
    expect(hostErrors[0]?.code).toBe('__acme:chat::other');
  });
});

describe('generic message handlers and lifecycle', () => {
  it('a plugin sees every frame, including other namespaces', () => {
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

    expect(events).toEqual(['welcome', '__other:plugin::ping', '__acme:watcher::tick']);
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

  it('does not run on a lazy socket idle-close, which reopens on demand', () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const Chat = plugin()({ id: 'acme:chat', setup: () => ({ dispose }) });

    const socket = client<AppContract>()(
      connect('wss://test', { lazy: true, lazyIdleTimeoutMs: 1000 }),
      Chat(),
    );
    socket.connect();
    MockWebSocket.last().open();

    // No consumers → the idle timer closes the transport. A lazy socket reopens on
    // the next use, so this close is not "finished for good" and must not dispose.
    vi.advanceTimersByTime(1000);
    expect(socket.state.get()).toBe('closed');
    expect(dispose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a plugin listener holds a lazy socket open past the idle window', () => {
    vi.useFakeTimers();
    const Chat = plugin<ChatWire>()({
      id: 'acme:chat',
      setup(socket) {
        socket.on('message', () => undefined);
        return {};
      },
    });

    const socket = client<AppContract>()(
      connect('wss://test', { lazy: true, lazyIdleTimeoutMs: 1000 }),
      Chat(),
    );
    socket.connect();
    MockWebSocket.last().open();

    // The plugin's `on('message')` counts as a consumer, like the top-level `on`,
    // so a receive-only plugin keeps the lazy socket open.
    vi.advanceTimersByTime(1000);
    expect(socket.state.get()).toBe('open');
    vi.useRealTimers();
  });

  it('runs once reconnection is exhausted', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const Chat = plugin()({ id: 'acme:chat', setup: () => ({ dispose }) });

    const socket = client<AppContract>()(
      connect('wss://test'),
      reconnection({ maxAttempts: 1 }),
      Chat(),
    );
    socket.connect();
    MockWebSocket.last().open();

    MockWebSocket.last().serverClose(1006, 'drop'); // first drop → schedules a retry
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances).toHaveLength(2); // the retry socket opened

    MockWebSocket.last().serverClose(1006, 'drop'); // retry fails → exhausted → closed
    expect(socket.state.get()).toBe('closed');

    await Promise.resolve(); // let the dispose microtask observe the final state
    expect(dispose).toHaveBeenCalledTimes(1);
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
    // app registered clientRequests — calling it names what to add.
    const Chat = plugin<ChatWire, { go: () => Promise<{ id: string }> }>()({
      id: 'acme:chat',
      setup(socket) {
        return { api: () => ({ go: () => socket.request('send-message', { text: 'x' }) }) };
      },
    });

    const { socket } = build(Chat());
    expect(() => Chat.use(socket).go()).toThrow(/clientRequests primitive isn't registered/);
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
