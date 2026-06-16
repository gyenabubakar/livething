import { ack, client, connect } from '@wskit/client';
import type { ServerAckClient } from '@wskit/tests-e2e-handlers/server-ack';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's ack() against the real `server-ack` handler, typed by
// the same contract the server implements (ServerAckClient =
// InferClient<handler>). The server pushes an event with sendWithAck; the ack()
// primitive auto-confirms the receipt with no app code, and the server's
// sendWithAck promise resolves — reported back as `ack-outcome`. The same path
// is exercised through both ctx.connection(ref).sendWithAck (trigger) and
// ctx.sendWithAck (trigger-timeout).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="trigger">trigger</button>
    <button data-testid="trigger-self">trigger-self</button>
    <span data-testid="status"></span>
    <span data-testid="acked-theme"></span>
    <span data-testid="outcome"></span>
    <span data-testid="ack-error"></span>
  `);

  const socket = client<ServerAckClient>()(connect(wsUrl('server-ack')), ack({ timeout: 2000 }));

  socket.subscribe(() => {
    el('status').textContent = socket.getState();
  });

  // The pushed event the client auto-confirms. The handler still runs after the
  // receipt is sent, so the theme is observable.
  socket.on('settings-updated', (data) => {
    el('acked-theme').textContent = data.theme;
  });
  socket.on('ack-outcome', (data) => {
    el('outcome').textContent = String(data.ok);
  });
  socket.on('ack-error', (data) => {
    el('ack-error').textContent = data.code;
  });

  button('connect', () => socket.connect());
  // Server sends via ctx.connection(ctx.self).sendWithAck(...).
  button('trigger', () => {
    socket.send('trigger', {});
  });
  // Server sends via ctx.sendWithAck(...).
  button('trigger-self', () => {
    socket.send('trigger-timeout', {});
  });

  ready();
}

setup();
