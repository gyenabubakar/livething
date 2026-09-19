import { client, clientRequests, connect } from '@livething/client';
import type { RequestClient } from '@livething/tests-e2e-handlers/request';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives connection-lifecycle behaviours against the real `request` server definition:
// idempotent connect(), disconnect() rejecting an in-flight request, and the
// socket.protocol / socket.ws properties.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="start-pending">start-pending</button>
    <button data-testid="disconnect">disconnect</button>
    <span data-testid="status"></span>
    <span data-testid="open-count"></span>
    <span data-testid="pending-error"></span>
    <span data-testid="protocol"></span>
    <span data-testid="ws-present"></span>
  `);

  const socket = client<RequestClient>()(connect(wsUrl('request')), clientRequests());

  let openCount = 0;
  socket.onOpen(() => {
    openCount += 1;
    el('open-count').textContent = String(openCount);
  });

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
    el('ws-present').textContent = socket.ws ? 'yes' : 'no';
    el('protocol').textContent = socket.protocol === null ? 'null' : socket.protocol;
  });

  button('connect', () => socket.connect());

  button('start-pending', async () => {
    try {
      // 'hang' is never answered by the server, so this request stays pending
      // until disconnect() rejects it.
      await socket.request('hang', {});
    } catch (err) {
      el('pending-error').textContent = errorCode(err);
    }
  });

  button('disconnect', () => socket.disconnect());

  el('open-count').textContent = '0';
  ready();
}

setup();
