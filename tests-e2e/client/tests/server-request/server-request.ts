import { client, connect, serverRequests } from '@wskit/client';
import type { ServerRequestClient } from '@wskit/tests-e2e-handlers/server-request';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's serverRequests() against the real `server-request`
// handler, typed by the same contract the server implements
// (ServerRequestClient = InferClient<handler>). The server asks the client a
// declared server→client request; the client answers with onRequest(), and the
// server reports the outcome back as an event.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="answer-good">answer-good</button>
    <button data-testid="answer-bad">answer-bad</button>
    <button data-testid="answer-drop">answer-drop</button>
    <button data-testid="trigger">trigger</button>
    <button data-testid="trigger-timeout">trigger-timeout</button>
    <span data-testid="status"></span>
    <span data-testid="ask-action"></span>
    <span data-testid="outcome"></span>
    <span data-testid="error-outcome"></span>
  `);

  const socket = client<ServerRequestClient>()(connect(wsUrl('server-request')), serverRequests());

  // How the next incoming server→client request should be answered. Swapped by
  // the answer-* buttons before a trigger so each case is deterministic.
  let mode: 'good' | 'bad' | 'drop' = 'good';

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.on('outcome', (data) => {
    el('outcome').textContent = String(data.allowed);
  });
  socket.on('error-outcome', (data) => {
    el('error-outcome').textContent = data.code;
  });

  // The handler that answers the server's question. Records the asked action so
  // the spec can prove the round-trip reached the client, then answers per mode.
  socket.onRequest('ask-permission', (payload) => {
    el('ask-action').textContent = payload.action;
    if (mode === 'drop') {
      // Never resolve: the server's request must hit its timeout.
      return new Promise<{ allowed: boolean }>(() => {});
    }
    if (mode === 'bad') {
      // Violates the response schema { allowed: boolean } so the server rejects
      // with request-invalid-response.
      return { allowed: 'nope' } as unknown as { allowed: boolean };
    }
    return { allowed: true };
  });

  button('connect', () => socket.connect());
  button('answer-good', () => {
    mode = 'good';
  });
  button('answer-bad', () => {
    mode = 'bad';
  });
  button('answer-drop', () => {
    mode = 'drop';
  });

  button('trigger', () => {
    socket.send('trigger', { action: 'delete' });
  });
  button('trigger-timeout', () => {
    socket.send('trigger-timeout', {});
  });

  ready();
}

setup();
