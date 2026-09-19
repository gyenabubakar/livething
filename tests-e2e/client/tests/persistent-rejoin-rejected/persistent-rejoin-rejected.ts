import { channels, client, connect, reconnection } from '@livething/client';
import type { PersistenceClient } from '@livething/tests-e2e-handlers/persistence';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives a PERSISTENT channel (archive-room) whose auto-rejoin the server
// REJECTS on reconnect: the user is banned mid-session, so the channel's
// `revalidate` hook throws, the server drops the durable membership row and
// sends a `rejoin-rejected` __error__ scoped to the channel.
//
// After that the client must treat the channel as unsubscribed — clearing
// `active` — so `send()` throws. The bug left it `active`, so the client kept
// "sending" into a channel the server had no membership for, and (because the
// client skips re-subscribing active+persistent channels on reconnect while the
// server has no row to rejoin) the divergence was permanent.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub">sub</button>
    <button data-testid="ban">ban</button>
    <button data-testid="drop">drop</button>
    <button data-testid="try-send">try-send</button>
    <span data-testid="status"></span>
    <span data-testid="on-subscribed"></span>
    <span data-testid="sub-failed"></span>
    <span data-testid="fail-code"></span>
    <span data-testid="send-result"></span>
  `);

  const username = new URLSearchParams(location.search).get('username') ?? 'alice';

  const socket = client<PersistenceClient>()(
    connect(wsUrl('persistence')),
    channels(),
    reconnection({ maxDelay: 400 }),
  );

  const room = socket.channel('archive-room');

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  let onSubscribed = 0;
  room.onSubscribed(() => {
    onSubscribed += 1;
    el('on-subscribed').textContent = String(onSubscribed);
  });

  let subFailed = 0;
  room.onSubscriptionFailed((err) => {
    subFailed += 1;
    el('sub-failed').textContent = String(subFailed);
    el('fail-code').textContent = errorCode(err);
  });

  button('connect', () => socket.connect());
  button('sub', async () => {
    await room.subscribe();
  });
  // Ban this identity so the next reconnect's revalidate hook rejects the rejoin.
  button('ban', () => {
    socket.send('ban', { identity: username });
  });
  button('drop', () => {
    socket.send('server-drop', {});
  });
  // After a rejected rejoin the channel must be unsubscribed: send() throws.
  button('try-send', () => {
    try {
      room.send('send-message', { text: 'after-reject' });
      el('send-result').textContent = 'sent';
    } catch (err) {
      el('send-result').textContent = `threw:${errorCode(err)}`;
    }
  });

  el('on-subscribed').textContent = '0';
  el('sub-failed').textContent = '0';
  ready();
}

setup();
