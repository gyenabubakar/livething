import { client, connect, stream } from '@wskit/client';
import type { SocketContract } from '@wskit/client';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client against the real `plugins` handler over the typed wire.
//
// Note on typing: the plugins handler lives in the cloudflare worker package
// (it needs the worker's `Env`/`Platform`/drizzle), so its `InferClient` type is
// not importable into this DOM-only tsconfig. More to the point, the client SDK
// does not surface `InferClient.plugins` as its own accessor — plugin traffic
// reaches a typed client through normal `on`/`send`/`stream` under the plugin's
// `__<id>::` wire prefix. So the relevant slice of the contract is declared
// directly here, matching the real wire shapes the handler exposes.
//
// Two things are proven:
//  1. Host traffic is typed and the observeHost plugin acts on it visibly: the
//     plugin's intercept rewrites `plugin-rewrite-probe`, its counters tick on
//     host messages, and its outgoing hook stamps the plugin-owned event.
//  2. A plugin-OWNED event reaches the client under its `__<id>::` prefix.
interface Contract extends SocketContract {
  incoming: {
    'record-inserted': { id: number };
    'plugin-rewrite-result': { text: string; rewritten?: boolean };
    'message-count': { count: number };
    'outgoing-count': { count: number };
    // Plugin-owned emit, namespaced by the `__<id>::` wire prefix. The outgoing
    // hook stamps `hooked: true` on it.
    '__e2e:drizzle::drizzle-ready': { tables: string[]; hooked?: boolean };
  };
  outgoing: {
    'insert-record': { name: string; value: string };
    'plugin-rewrite-probe': { text: string };
    'get-message-count': Record<string, never>;
    'get-outgoing-count': Record<string, never>;
  };
  streams: {
    'stream-connection-id': { payload: { count: number }; chunk: { id: string } };
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
    <span data-testid="status"></span>
    <span data-testid="drizzle-ready"></span>
    <span data-testid="drizzle-hooked"></span>
    <span data-testid="inserted-id"></span>
    <span data-testid="rewrite-result"></span>
    <span data-testid="msg-count-result"></span>
    <span data-testid="outgoing-count-result"></span>
    <span data-testid="stream-ids"></span>
  `);

  const socket = client<Contract>()(connect(wsUrl('plugins')), stream());

  socket.subscribe(() => {
    el('status').textContent = socket.getState();
  });

  // Plugin-owned event under the `__<id>::` prefix. The outgoing hook stamps
  // `hooked: true`, so its presence proves the host-observing plugin's outgoing
  // hook ran on the plugin's own emit.
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

  ready();
}

setup();
