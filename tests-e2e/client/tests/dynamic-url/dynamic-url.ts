import { client, connect, reconnection } from '@wskit/client';
import type { ReplayClient } from '@wskit/tests-e2e-handlers/replay-history';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives connect() with a URL *function* against the real `replay` handler. The
// function runs on every connect and every reconnect, so a server-initiated drop
// (server-drop → retryable close) makes the client call it again. Also records
// open/reconnect hook order: onOpen must fire before onReconnect on a reconnect.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="drop">drop</button>
    <span data-testid="status"></span>
    <span data-testid="url-count"></span>
    <span data-testid="hook-order"></span>
  `);

  let urlCount = 0;
  const order: string[] = [];

  const socket = client<ReplayClient>()(
    connect(() => {
      urlCount += 1;
      el('url-count').textContent = String(urlCount);
      return wsUrl('replay');
    }),
    reconnection({ maxDelay: 400 }),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.onOpen(() => {
    order.push('open');
    el('hook-order').textContent = order.join(',');
  });
  socket.onReconnect(() => {
    order.push('reconnect');
    el('hook-order').textContent = order.join(',');
  });

  button('connect', () => socket.connect());
  button('drop', () => {
    socket.send('server-drop', {});
  });

  el('url-count').textContent = '0';
  ready();
}

setup();
