import { client, connect, reconnection } from '@livething/client';
import type { ErrorsControlFlowClient } from '@livething/tests-e2e-handlers/errors-control-flow';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @livething/client's reconnection() against the real `errors-control-flow`
// server definition. Its close behavior uses code 4009, which is listed
// as non-retryable — so the socket must settle to `closed`, not `reconnecting`.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="force-disconnect">force-disconnect</button>
    <span data-testid="status"></span>
    <span data-testid="close-code"></span>
    <span data-testid="close-reason"></span>
  `);

  const socket = client<ErrorsControlFlowClient>()(
    connect(wsUrl('errors-control-flow')),
    reconnection({ nonRetryableCodes: [4009] }),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.onClose((event) => {
    el('close-code').textContent = String(event.code);
    el('close-reason').textContent = event.reason;
  });

  button('connect', () => socket.connect());

  button('force-disconnect', () => {
    socket.send('force-disconnect', {});
  });

  ready();
}

setup();
