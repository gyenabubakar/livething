import { ack, client, connect } from '@wskit/client';
import type { AckClient } from '@wskit/tests-e2e-handlers/ack';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's ack() against the real `ack` handler, typed by the same
// contract the server implements (AckClient = InferClient<handler>). A small ack
// timeout keeps the throw case fast.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="send-ok">send-ok</button>
    <button data-testid="send-throw">send-throw</button>
    <span data-testid="status"></span>
    <span data-testid="acked"></span>
    <span data-testid="throw-error"></span>
  `);

  const socket = client<AckClient>()(connect(wsUrl('ack')), ack({ timeout: 500 }));

  socket.subscribe(() => {
    el('status').textContent = socket.getState();
  });

  button('connect', () => socket.connect());

  button('send-ok', async () => {
    await socket.sendWithAck('ack-check', {});
    el('acked').textContent = 'yes';
  });

  button('send-throw', async () => {
    try {
      await socket.sendWithAck('throw-me', {});
    } catch (err) {
      el('throw-error').textContent = errorCode(err);
    }
  });

  ready();
}

setup();
