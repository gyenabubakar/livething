import { channels, client, connect, dedup, inbox, reconnection } from '@wskit/client';
import type { InboxClient } from '@wskit/tests-e2e-handlers/inbox';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's inbox() against the real inbox server definition: a persistent,
// inbox-backed channel that writes a durable per-member row on every broadcast
// and holds it until the member acks `__received__`. A member OFFLINE at
// broadcast time still receives the message — its rows drain on reconnect (after
// auto-rejoin), and dedup drops any live copy it already saw. Each arrival is
// appended once so a spec can prove no double-delivery across reconnects.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="disconnect">disconnect</button>
    <button data-testid="sub">sub</button>
    <button data-testid="send-m1">send-m1</button>
    <button data-testid="send-m2">send-m2</button>
    <button data-testid="send-m3">send-m3</button>
    <span data-testid="status"></span>
    <span data-testid="reconnects"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="messages"></span>
    <span data-testid="message-count"></span>
  `);

  const socket = client<InboxClient>()(
    connect(wsUrl('inbox')),
    channels(),
    inbox(),
    dedup(),
    reconnection({ maxDelay: 400 }),
  );

  const chat = socket.channel('chat');

  const seen: string[] = [];
  chat.on('room-msg', (msg) => {
    seen.push(msg.text);
    el('messages').textContent = seen.join(',');
    el('message-count').textContent = String(seen.length);
  });

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  let reconnects = 0;
  socket.onReconnect(() => {
    reconnects += 1;
    el('reconnects').textContent = String(reconnects);
  });

  button('connect', () => socket.connect());
  button('disconnect', () => socket.disconnect());
  button('sub', async () => {
    await chat.subscribe();
    el('subscribed').textContent = 'yes';
  });
  button('send-m1', () => {
    chat.send('send-room-msg', { text: 'm1' });
  });
  button('send-m2', () => {
    chat.send('send-room-msg', { text: 'm2' });
  });

  button('send-m3', () => {
    chat.send('send-room-msg', { text: 'm3' });
  });

  el('reconnects').textContent = '0';
  el('message-count').textContent = '0';
  ready();
}

setup();
