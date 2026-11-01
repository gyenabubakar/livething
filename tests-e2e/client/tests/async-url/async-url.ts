import { client, connect } from '@livething/client';
import type { CtxMetaClient } from '@livething/tests-e2e-handlers/ctx-meta';
import { button, el, mount, ready } from '../_shared.ts';

// Drives connect() with an async URL function against the real `ctx-meta` server definition.
// The function adds `username` to the query string after an await, so the
// server's upgrade reads it from the URL and echoes it back through who-am-i.
// Proves a param built by an async URL function reaches the server on connect.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="who-am-i">who-am-i</button>
    <span data-testid="status"></span>
    <span data-testid="username"></span>
  `);

  const page = new URLSearchParams(location.search);
  const room = page.get('room') ?? 'default';
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';

  async function loadUsername(): Promise<string> {
    await Promise.resolve();
    return 'q-user';
  }

  const socket = client<CtxMetaClient>()(
    connect(async () => {
      const params = new URLSearchParams({ room, username: await loadUsername() });
      return `${scheme}://${location.host}/ws/ctx-meta?${params}`;
    }),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.on('who-am-i-result', (p) => {
    el('username').textContent = p.username;
  });

  button('connect', () => socket.connect());
  button('who-am-i', () => {
    socket.send('who-am-i', {});
  });

  ready();
}

setup();
