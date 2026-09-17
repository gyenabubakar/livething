import { channels, client, clientRequests, connect, stream } from '@wskit/client';
import type { SocketContract } from '@wskit/client';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client against the real `plugins` server definition over the typed wire.
//
// Note on typing: the plugins server definition lives in the Cloudflare Worker package
// (it needs the worker's `Env`/`Platform`/drizzle), so its `InferClient` type is
// not importable into this DOM-only tsconfig. More to the point, the client SDK
// does not surface `InferClient.plugins` as its own accessor — plugin traffic
// reaches a typed client through normal `on`/`send`/`stream` under the plugin's
// `__<id>::` wire prefix. So the relevant slice of the contract is declared
// directly here, matching the real wire shapes the server definition exposes.
//
// Two things are proven:
//  1. Plugin hooks rewrite frames, count messages, and stamp plugin-owned events.
//  2. A plugin-owned event reaches the client under its `__<id>::` prefix.
interface Contract extends SocketContract {
  incoming: {
    'record-inserted': { id: number };
    'plugin-rewrite-result': { text: string; rewritten?: boolean };
    'message-count': { count: number };
    'outgoing-count': { count: number };
    // Plugin-owned emit, namespaced by the `__<id>::` wire prefix. The outgoing
    // hook stamps `hooked: true` on it.
    '__e2e:drizzle::drizzle-ready': { tables: string[]; hooked?: boolean };
    // The Feed plugin's own emit, sent in reply to its `hello` incoming handler.
    '__e2e:feed::welcome': { name: string };
  };
  outgoing: {
    'insert-record': { name: string; value: string };
    'plugin-rewrite-probe': { text: string };
    'get-message-count': Record<string, never>;
    'get-outgoing-count': Record<string, never>;
    // Client → Feed plugin incoming handler.
    '__e2e:feed::hello': { name: string };
  };
  clientRequests: {
    // Client → Feed plugin request, plugin returns the response.
    '__e2e:feed::echo': { payload: { text: string }; response: { echoed: string } };
  };
  streams: {
    'stream-connection-id': { payload: { count: number }; chunk: { id: string } };
    // Plugin-OWNED streams, one per kind. The durable ones declare no
    // persistence — the host provides it because the requirement is auto-derived
    // from the streams the plugin owns.
    '__e2e:feed::feed': { payload: { from: number }; chunk: { row: number } };
    '__e2e:feed::feed-plain': { payload: Record<string, never>; chunk: { n: number } };
    '__e2e:feed::feed-recorded': { payload: Record<string, never>; chunk: { n: number } };
  };
  channels: {
    // A plugin-OWNED channel: the channel name is `__<id>::`-prefixed, but its
    // events stay bare within that channel scope.
    '__e2e:feed::room': { incoming: { joined: { who: string } } };
  };
}

export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="insert">insert</button>
    <button data-testid="rewrite">rewrite</button>
    <button data-testid="msg-count">msg-count</button>
    <button data-testid="outgoing-count">outgoing-count</button>
    <button data-testid="stream-conn-id">stream-conn-id</button>
    <button data-testid="stream-feed">stream-feed</button>
    <button data-testid="feed-hello">feed-hello</button>
    <button data-testid="feed-echo">feed-echo</button>
    <button data-testid="stream-feed-plain">stream-feed-plain</button>
    <button data-testid="stream-feed-recorded">stream-feed-recorded</button>
    <button data-testid="feed-sub-room">feed-sub-room</button>
    <span data-testid="status"></span>
    <span data-testid="drizzle-ready"></span>
    <span data-testid="drizzle-hooked"></span>
    <span data-testid="inserted-id"></span>
    <span data-testid="rewrite-result"></span>
    <span data-testid="msg-count-result"></span>
    <span data-testid="outgoing-count-result"></span>
    <span data-testid="stream-ids"></span>
    <span data-testid="feed-rows"></span>
    <span data-testid="feed-welcome"></span>
    <span data-testid="feed-echo-result"></span>
    <span data-testid="feed-plain-rows"></span>
    <span data-testid="feed-recorded-rows"></span>
    <span data-testid="feed-joined"></span>
  `);

  const socket = client<Contract>()(
    connect(wsUrl('plugins')),
    stream(),
    clientRequests(),
    channels(),
  );

  const feedRoom = socket.channel('__e2e:feed::room');
  feedRoom.on('joined', (data) => {
    el('feed-joined').textContent = data.who ? 'joined' : '';
  });

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  // Plugin-owned event under the `__<id>::` prefix. The outgoing hook stamps
  // `hooked: true` on the plugin's own emit.
  socket.on('__e2e:drizzle::drizzle-ready', (data) => {
    el('drizzle-ready').textContent = data.tables.join(',');
    el('drizzle-hooked').textContent = data.hooked ? 'yes' : 'no';
  });

  socket.on('record-inserted', (data) => {
    el('inserted-id').textContent = String(data.id);
  });
  socket.on('plugin-rewrite-result', (data) => {
    el('rewrite-result').textContent = `${data.text}|${data.rewritten ?? false}`;
  });
  socket.on('message-count', (data) => {
    el('msg-count-result').textContent = String(data.count);
  });
  socket.on('outgoing-count', (data) => {
    el('outgoing-count-result').textContent = String(data.count);
  });
  // Plugin-owned emit sent in reply to the plugin's own incoming handler.
  socket.on('__e2e:feed::welcome', (data) => {
    el('feed-welcome').textContent = data.name;
  });

  const streamIds: string[] = [];

  button('connect', () => socket.connect());
  button('insert', () => {
    socket.send('insert-record', { name: 'test-item', value: 'hello' });
  });
  button('rewrite', () => {
    socket.send('plugin-rewrite-probe', { text: 'hello' });
  });
  button('msg-count', () => {
    socket.send('get-message-count', {});
  });
  button('outgoing-count', () => {
    socket.send('get-outgoing-count', {});
  });

  // A plugin-backed stream: each chunk carries the current connection id read
  // from the plugin api inside the generator, proving plugin streams reach the
  // typed client.
  button('stream-conn-id', async () => {
    const handle = await socket.stream('stream-connection-id', { count: 3 });
    for await (const chunk of handle) {
      if (chunk.id) streamIds.push(chunk.id);
      el('stream-ids').textContent = streamIds.join(',');
    }
  });

  // Drive the plugin-OWNED durable stream over the typed wire — proof the
  // capability-requirement model lets a plugin ship a durable stream end to end.
  const feedRows: number[] = [];
  button('stream-feed', async () => {
    const handle = await socket.stream('__e2e:feed::feed', { from: 0 }, { streamId: 'feed-1' });
    for await (const chunk of handle) {
      feedRows.push(chunk.row);
      el('feed-rows').textContent = feedRows.join(',');
    }
  });

  // Client → plugin incoming event; the plugin replies with its own emit.
  button('feed-hello', () => {
    socket.send('__e2e:feed::hello', { name: 'alice' });
  });

  // Client → plugin request; the plugin returns the response.
  button('feed-echo', async () => {
    const res = await socket.request('__e2e:feed::echo', { text: 'hello' });
    el('feed-echo-result').textContent = res.echoed;
  });

  // Plugin-owned plain (ephemeral) stream.
  const plainRows: number[] = [];
  button('stream-feed-plain', async () => {
    const handle = await socket.stream('__e2e:feed::feed-plain', {});
    for await (const chunk of handle) {
      plainRows.push(chunk.n);
      el('feed-plain-rows').textContent = plainRows.join(',');
    }
  });

  // Plugin-owned recorded (durable, buffered) stream.
  const recordedRows: number[] = [];
  button('stream-feed-recorded', async () => {
    const handle = await socket.stream('__e2e:feed::feed-recorded', {}, { streamId: 'rec-1' });
    for await (const chunk of handle) {
      recordedRows.push(chunk.n);
      el('feed-recorded-rows').textContent = recordedRows.join(',');
    }
  });

  // Client → plugin-owned channel: subscribe and receive its broadcast.
  button('feed-sub-room', async () => {
    await feedRoom.subscribe();
  });

  ready();
}

setup();
