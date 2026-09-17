import { channels, client, clientRequests, connect } from '@wskit/client';
import type { RequestClient } from '@wskit/tests-e2e-handlers/request';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's request() against the real `request` server definition, typed by
// the same contract the server implements (RequestClient = InferClient<definition>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="get-time">get-time</button>
    <button data-testid="no-response">no-response</button>
    <button data-testid="throwing-request">throwing-request</button>
    <button data-testid="sub-room">sub-room</button>
    <button data-testid="ch-info">ch-info</button>
    <span data-testid="status"></span>
    <span data-testid="time"></span>
    <span data-testid="no-response-result"></span>
    <span data-testid="no-response-value"></span>
    <span data-testid="throw-error"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="ch-result"></span>
  `);

  const socket = client<RequestClient>()(connect(wsUrl('request')), clientRequests(), channels());

  const room = socket.channel('room');

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  button('connect', () => socket.connect());

  button('get-time', async () => {
    const res = await socket.request('get-time', {});
    el('time').textContent = res.now;
  });

  button('no-response', async () => {
    // Resolves with no value — a void acknowledgement, not a rejection.
    const res = await socket.request('no-response', {});
    el('no-response-result').textContent = 'acked';
    el('no-response-value').textContent = res === undefined ? 'undefined' : JSON.stringify(res);
  });

  button('throwing-request', async () => {
    // A handler that throws still rejects the client's request().
    try {
      await socket.request('throwing-request', {});
    } catch (err) {
      el('throw-error').textContent = errorCode(err);
    }
  });

  button('sub-room', async () => {
    await room.subscribe();
    el('subscribed').textContent = 'yes';
  });

  button('ch-info', async () => {
    const res = await room.request('get-channel-info', {});
    el('ch-result').textContent = res.channel;
  });

  ready();
}

setup();
