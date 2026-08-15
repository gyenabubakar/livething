import { buffering, client, clientRequests, connect, reconnection } from '@wskit/client';
import type { PersistenceClient } from '@wskit/tests-e2e-handlers/persistence';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client against the real `persistence` handler to prove the
// buffered-op ownership rule: a request that is buffered while the socket is
// reconnecting and then TIMES OUT is not sent when the socket reopens — the
// server never runs an operation the caller was already told failed. `record-exec`
// increments a durable counter when it actually runs; `read-exec-count` reads it.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="server-drop">server-drop</button>
    <button data-testid="record-exec">record-exec</button>
    <button data-testid="read-count">read-count</button>
    <span data-testid="status"></span>
    <span data-testid="record-result"></span>
    <span data-testid="exec-count"></span>
  `);

  const socket = client<PersistenceClient>()(
    connect(wsUrl('persistence')),
    clientRequests(),
    reconnection(),
    buffering({ enabled: true }),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  button('connect', () => socket.connect());
  button('server-drop', () => {
    socket.send('server-drop', {});
  });

  // A short timeout so the buffered request settles before the reconnect flush.
  button('record-exec', async () => {
    try {
      await socket.request('record-exec', {}, { timeout: 150 });
      el('record-result').textContent = 'resolved';
    } catch (err) {
      el('record-result').textContent = errorCode(err);
    }
  });

  button('read-count', async () => {
    const res = await socket.request('read-exec-count', {});
    el('exec-count').textContent = String(res.count);
  });

  ready();
}

setup();
