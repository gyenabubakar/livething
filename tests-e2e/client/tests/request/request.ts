import { channels, client, connect, requestResponse } from '@wskit/client';
import type { RequestClient } from '@wskit/tests-e2e-handlers/request';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's request() against the real `request` handler, typed by
// the same contract the server implements (RequestClient = InferClient<handler>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="get-time">get-time</button>
    <button data-testid="no-response">no-response</button>
    <button data-testid="sub-room">sub-room</button>
    <button data-testid="ch-info">ch-info</button>
    <span data-testid="status"></span>
    <span data-testid="time"></span>
    <span data-testid="no-response-error"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="ch-result"></span>
  `);

  const socket = client<RequestClient>()(connect(wsUrl('request')), requestResponse(), channels());

  const room = socket.channel('room');

  socket.subscribe(() => {
    el('status').textContent = socket.getState();
  });

  button('connect', () => socket.connect());

  button('get-time', async () => {
    const res = await socket.request('get-time', {});
    el('time').textContent = res.now;
  });

  button('no-response', async () => {
    try {
      await socket.request('no-response', {});
    } catch (err) {
      el('no-response-error').textContent = errorCode(err);
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
