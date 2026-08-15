import { channels, client, clientRequests, connect, plugin, stream } from '@wskit/client';
import { WSKitError } from '@wskit/client/errors';
import type { StreamHandle } from '@wskit/client';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client against the real `plugins` handler through a CLIENT
// PLUGIN, the mirror of the server's `e2e:feed` plugin. The client plugin owns
// the `e2e:feed` namespace, so its `setup` works in plain names — `on('welcome')`,
// `send('hello')`, `request('echo')`, `stream('feed')`, `channel('room')` — and
// the framework adds the `__e2e:feed::` prefix on the wire. This proves the
// scoped socket round-trips every verb over the real wire, and that the plugin
// owns its namespace: a raw top-level listener for a plugin frame never fires.

// The plugin's slice of the wire, in plain names. It matches the server plugin's
// contract; a full-stack app could derive this from the server with
// InferPluginClient.
interface FeedWire {
  incoming: { welcome: { name: string } };
  outgoing: { hello: { name: string } };
  clientRequests: { echo: { payload: { text: string }; response: { echoed: string } } };
  streams: {
    feed: { payload: { from: number }; chunk: { row: number } };
    nudgeable: {
      payload: Record<string, never>;
      chunk: { n: number };
      nudges: { boost: { amount: number } };
    };
    'feed-plain': { payload: Record<string, never>; chunk: { n: number } };
    'feed-recorded': { payload: Record<string, never>; chunk: { n: number } };
  };
  channels: {
    room: {
      outgoing: { chat: { text: string } };
      incoming: { joined: { who: string }; said: { text: string } };
    };
    thread: { addressing: 'dynamic'; incoming: { posted: { thread: string } } };
  };
}

// The app's contract as `InferClient` produces it: the plugin's names under their
// `__e2e:feed::` wire prefix. Registering the plugin requires these to be present,
// then the framework strips them from the top-level socket and re-exposes them
// scoped inside the plugin.
interface FeedHost {
  incoming: { '__e2e:feed::welcome': { name: string } };
  outgoing: { '__e2e:feed::hello': { name: string } };
  clientRequests: {
    '__e2e:feed::echo': { payload: { text: string }; response: { echoed: string } };
  };
  streams: {
    '__e2e:feed::feed': { payload: { from: number }; chunk: { row: number } };
    '__e2e:feed::nudgeable': {
      payload: Record<string, never>;
      chunk: { n: number };
      nudges: { boost: { amount: number } };
    };
    '__e2e:feed::feed-plain': { payload: Record<string, never>; chunk: { n: number } };
    '__e2e:feed::feed-recorded': { payload: Record<string, never>; chunk: { n: number } };
  };
  channels: {
    '__e2e:feed::room': {
      outgoing: { chat: { text: string } };
      incoming: { joined: { who: string }; said: { text: string } };
    };
    '__e2e:feed::thread': { addressing: 'dynamic'; incoming: { posted: { thread: string } } };
  };
}

interface FeedApi {
  onWelcome(cb: (name: string) => void): void;
  hello(name: string): void;
  echo(text: string): Promise<{ echoed: string }>;
  streamFeed(): Promise<StreamHandle<{ row: number }>>;
  streamPlain(): Promise<StreamHandle<{ n: number }>>;
  streamRecorded(): Promise<StreamHandle<{ n: number }>>;
  boost(): Promise<string>;
  joinRoom(onJoined: (who: string) => void): Promise<void>;
  onSaid(cb: (text: string) => void): void;
  chat(text: string): void;
  joinThread(id: string, onPosted: (thread: string) => void): Promise<void>;
}

const Feed = plugin<FeedWire, FeedApi>()({
  id: 'e2e:feed',
  dependencies: [clientRequests, stream, channels],
  setup(socket) {
    const welcomeCbs = new Set<(name: string) => void>();
    const joinedCbs = new Set<(who: string) => void>();
    const saidCbs = new Set<(text: string) => void>();

    // Scoped receive: `welcome` arrives on the wire as `__e2e:feed::welcome`.
    socket.on('welcome', (m) => welcomeCbs.forEach((cb) => cb(m.name)));

    const room = socket.channel('room');
    room.on('joined', (m) => joinedCbs.forEach((cb) => cb(m.who)));
    room.on('said', (m) => saidCbs.forEach((cb) => cb(m.text)));

    return {
      api: () => ({
        onWelcome: (cb) => void welcomeCbs.add(cb),
        hello: (name) => void socket.send('hello', { name }),
        echo: (text) => socket.request('echo', { text }),
        streamFeed: () => socket.stream('feed', { from: 0 }, { streamId: 'scoped-feed' }),
        streamPlain: () => socket.stream('feed-plain', {}),
        streamRecorded: () => socket.stream('feed-recorded', {}, { streamId: 'scoped-rec' }),
        // Trigger the slow stream, wait for the first chunk so it's live, then
        // nudge it. The nudge only resolves if its event reached the server's
        // registered `__e2e:feed::boost` — i.e. the plugin namespaced it.
        boost: async () => {
          const handle = await socket.stream('nudgeable', {});
          await handle[Symbol.asyncIterator]().next();
          try {
            await handle.nudge('boost', { amount: 2 });
            return 'ok';
          } catch (error) {
            return error instanceof WSKitError ? error.code : String(error);
          } finally {
            handle.cancel();
          }
        },
        joinRoom: (onJoined) => {
          joinedCbs.add(onJoined);
          return room.subscribe();
        },
        onSaid: (cb) => void saidCbs.add(cb),
        // Send on the plugin channel: `chat` must go out as `__e2e:feed::chat`
        // (namespaced) so the server's channel handler receives it.
        chat: (text) => void room.send('chat', { text }),
        // A dynamic-family member: `thread:<id>` under the plugin namespace.
        joinThread: (id, onPosted) => {
          const t = socket.channel('thread', `thread:${id}`);
          t.on('posted', (m) => onPosted(m.thread));
          return t.subscribe();
        },
      }),
    };
  },
});

export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="hello">hello</button>
    <button data-testid="echo">echo</button>
    <button data-testid="echo-fail">echo-fail</button>
    <button data-testid="stream-feed">stream-feed</button>
    <button data-testid="stream-plain">stream-plain</button>
    <button data-testid="stream-recorded">stream-recorded</button>
    <button data-testid="nudge">nudge</button>
    <button data-testid="join-room">join-room</button>
    <button data-testid="join-room-fail">join-room-fail</button>
    <button data-testid="chat">chat</button>
    <button data-testid="join-thread">join-thread</button>
    <span data-testid="status"></span>
    <span data-testid="welcome"></span>
    <span data-testid="raw-welcome"></span>
    <span data-testid="echo-result"></span>
    <span data-testid="echo-error"></span>
    <span data-testid="feed-rows"></span>
    <span data-testid="plain-rows"></span>
    <span data-testid="recorded-rows"></span>
    <span data-testid="nudge-result"></span>
    <span data-testid="joined"></span>
    <span data-testid="subscribe-error"></span>
    <span data-testid="said"></span>
    <span data-testid="posted"></span>
  `);

  // The app's only names are the plugin's, under its namespace. The contract
  // declares them (as InferClient would), which registering the plugin requires;
  // the plugin then owns them and the top-level socket exposes none.
  const socket = client<FeedHost>()(
    connect(wsUrl('plugins')),
    clientRequests(),
    stream(),
    channels(),
    Feed(),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  const feed = Feed.use(socket);
  feed.onWelcome((name) => {
    el('welcome').textContent = name;
  });

  // The plugin owns __e2e:feed::welcome, so this raw top-level listener must never
  // fire — the plugin claims the frame before the app sees it.
  (socket as unknown as { on(event: string, handler: (data: { name: string }) => void): void }).on(
    '__e2e:feed::welcome',
    (data) => {
      el('raw-welcome').textContent = data.name;
    },
  );

  async function drain(
    handle: Promise<StreamHandle<{ row: number } | { n: number }>>,
    target: string,
  ): Promise<void> {
    const rows: number[] = [];
    for await (const chunk of await handle) {
      rows.push('row' in chunk ? chunk.row : chunk.n);
      el(target).textContent = rows.join(',');
    }
  }

  button('connect', () => socket.connect());
  button('hello', () => feed.hello('alice'));
  button('echo', async () => {
    const res = await feed.echo('hello');
    el('echo-result').textContent = res.echoed;
  });
  // The server throws its declared `room-full` on this input; the rejection must
  // reach the app as the plain `room-full`, not the namespaced wire code.
  button('echo-fail', () => {
    void feed.echo('boom').catch((error: unknown) => {
      el('echo-error').textContent = error instanceof WSKitError ? error.code : String(error);
    });
  });
  button('stream-feed', () => drain(feed.streamFeed(), 'feed-rows'));
  button('stream-plain', () => drain(feed.streamPlain(), 'plain-rows'));
  button('stream-recorded', () => drain(feed.streamRecorded(), 'recorded-rows'));
  button('nudge', async () => {
    el('nudge-result').textContent = await feed.boost();
  });
  button('join-room', () => {
    feed.onSaid((text) => {
      el('said').textContent = text;
    });
    return feed.joinRoom((who) => {
      el('joined').textContent = who ? 'joined' : '';
    });
  });
  // The server's channel `check` throws its declared `room-full` for a blocked
  // user; the subscribe rejection must carry the plain code, not the namespaced one.
  button('join-room-fail', () => {
    void feed
      .joinRoom(() => undefined)
      .catch((error: unknown) => {
        el('subscribe-error').textContent =
          error instanceof WSKitError ? error.code : String(error);
      });
  });
  // Send on the plugin channel; the server echoes it back as `said`, which only
  // arrives if the outgoing `chat` reached the server's namespaced handler.
  button('chat', () => feed.chat('hey room'));
  button('join-thread', () =>
    // Join one specific thread; the server echoes back the concrete member it saw.
    feed.joinThread('general', (thread) => {
      el('posted').textContent = thread.endsWith('thread:general') ? 'general' : thread;
    }),
  );

  ready();
}

setup();
