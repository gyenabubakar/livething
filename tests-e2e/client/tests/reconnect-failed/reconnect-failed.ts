import { client, connect, reconnection } from '@wskit/client';
import type { RequestClient } from '@wskit/tests-e2e-handlers/request';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's reconnection give-up path. The URL points at a route
// the server doesn't serve, so every handshake fails. With a tiny attempt
// budget, reconnection exhausts fast and fires onReconnectFailed, then settles
// in 'closed'.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <span data-testid="status"></span>
    <span data-testid="reconnect-failed"></span>
  `);

  const socket = client<RequestClient>()(
    connect(wsUrl('does-not-exist')),
    reconnection({ maxAttempts: 2, maxDelay: 100 }),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.onReconnectFailed(() => {
    el('reconnect-failed').textContent = 'yes';
  });

  button('connect', () => socket.connect());

  el('reconnect-failed').textContent = 'no';
  ready();
}

setup();
