import { client, connect, query } from '@wskit/client';
import type { CtxMetaClient } from '@wskit/tests-e2e-handlers/ctx-meta';
import { button, el, mount, ready } from '../_shared.ts';

// Drives @wskit/client's query() primitive against the real `ctx-meta` server definition.
// The connect URL deliberately omits `username`; query() supplies it, so the
// server's upgrade reads it from the query string and echoes it back through
// who-am-i. Proves query params reach the server on connect.
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
  // No username in the URL — query() is the only source of it.
  const url = `${scheme}://${location.host}/ws/ctx-meta?room=${encodeURIComponent(room)}`;

  const socket = client<CtxMetaClient>()(
    connect(url),
    query(() => ({ username: 'q-user' })),
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
