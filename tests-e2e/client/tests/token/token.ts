import { client, connect } from '@livething/client';
import type { CtxMetaClient } from '@livething/tests-e2e-handlers/ctx-meta';
import { button, el, mount, ready } from '../_shared.ts';

// Drives connect() with the `token` option against the real `ctx-meta` server definition.
// The URL carries no username. The token travels in Sec-WebSocket-Protocol, the server
// moves it to `Authorization`, and authenticate reads the username from it.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="who-am-i">who-am-i</button>
    <span data-testid="status"></span>
    <span data-testid="username"></span>
    <span data-testid="protocol"></span>
  `);

  const page = new URLSearchParams(location.search);
  const room = page.get('room') ?? 'default';
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';

  const socket = client<CtxMetaClient>()(
    connect(`${scheme}://${location.host}/ws/ctx-meta?room=${encodeURIComponent(room)}`, {
      token: async () => 'token-user',
    }),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
    el('protocol').textContent = String(socket.protocol);
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
