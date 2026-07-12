import { channels, client, connect, plugin, requestResponse, stream } from '@wskit/client';
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
  requests: { echo: { payload: { text: string }; response: { echoed: string } } };
  streams: {
    feed: { payload: { from: number }; chunk: { row: number } };
    'feed-plain': { payload: Record<string, never>; chunk: { n: number } };
    'feed-recorded': { payload: Record<string, never>; chunk: { n: number } };
  };
  channels: {
    room: { incoming: { joined: { who: string } } };
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
  requests: {
    '__e2e:feed::echo': { payload: { text: string }; response: { echoed: string } };
  };
  streams: {
    '__e2e:feed::feed': { payload: { from: number }; chunk: { row: number } };
    '__e2e:feed::feed-plain': { payload: Record<string, never>; chunk: { n: number } };
    '__e2e:feed::feed-recorded': { payload: Record<string, never>; chunk: { n: number } };
  };
  channels: {
    '__e2e:feed::room': { incoming: { joined: { who: string } } };
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
  joinRoom(onJoined: (who: string) => void): Promise<void>;
  joinThread(id: string, onPosted: (thread: string) => void): Promise<void>;
}

const Feed = plugin<FeedWire, FeedApi>()({
  id: 'e2e:feed',
  dependencies: [requestResponse, stream, channels],
  setup(socket) {
    const welcomeCbs = new Set<(name: string) => void>();
    const joinedCbs = new Set<(who: string) => void>();

    // Scoped receive: `welcome` arrives on the wire as `__e2e:feed::welcome`.
    socket.on('welcome', (m) => welcomeCbs.forEach((cb) => cb(m.name)));

    const room = socket.channel('room');
    room.on('joined', (m) => joinedCbs.forEach((cb) => cb(m.who)));

    return {
      api: () => ({
        onWelcome: (cb) => void welcomeCbs.add(cb),
        hello: (name) => void socket.send('hello', { name }),
        echo: (text) => socket.request('echo', { text }),
        streamFeed: () => socket.stream('feed', { from: 0 }, { streamId: 'scoped-feed' }),
        streamPlain: () => socket.stream('feed-plain', {}),
        streamRecorded: () => socket.stream('feed-recorded', {}, { streamId: 'scoped-rec' }),
        joinRoom: (onJoined) => {
          joinedCbs.add(onJoined);
          return room.subscribe();
        },
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
    <button data-testid="stream-feed">stream-feed</button>
    <button data-testid="stream-plain">stream-plain</button>
    <button data-testid="stream-recorded">stream-recorded</button>
    <button data-testid="join-room">join-room</button>
    <button data-testid="join-thread">join-thread</button>
    <span data-testid="status"></span>
    <span data-testid="welcome"></span>
    <span data-testid="raw-welcome"></span>
    <span data-testid="echo-result"></span>
    <span data-testid="feed-rows"></span>
    <span data-testid="plain-rows"></span>
    <span data-testid="recorded-rows"></span>
    <span data-testid="joined"></span>
    <span data-testid="posted"></span>
  `);

  // The app's only names are the plugin's, under its namespace. The contract
  // declares them (as InferClient would), which registering the plugin requires;
  // the plugin then owns them and the top-level socket exposes none.
  const socket = client<FeedHost>()(
    connect(wsUrl('plugins')),
    requestResponse(),
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
  button('stream-feed', () => drain(feed.streamFeed(), 'feed-rows'));
  button('stream-plain', () => drain(feed.streamPlain(), 'plain-rows'));
  button('stream-recorded', () => drain(feed.streamRecorded(), 'recorded-rows'));
  button('join-room', () =>
    feed.joinRoom((who) => {
      el('joined').textContent = who ? 'joined' : '';
    }),
  );
  button('join-thread', () =>
    // Join one specific thread; the server echoes back the concrete member it saw.
    feed.joinThread('general', (thread) => {
      el('posted').textContent = thread.endsWith('thread:general') ? 'general' : thread;
    }),
  );

  ready();
}

setup();
