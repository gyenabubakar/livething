import { channels, client, connect, reconnection } from '@wskit/client';
import type { PersistenceClient } from '@wskit/tests-e2e-handlers/persistence';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives a PERSISTENT, check-gated channel (archive-room) through a warm
// reconnect. The server auto-rejoins the durable membership; the client must NOT
// re-subscribe. Counts the client's onSubscribed callbacks and the server's
// per-subscribe-flow ack so a double subscribe flow would be visible, and tracks
// members + room messages so presence and a witness broadcast can be asserted
// across the reconnect.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub">sub</button>
    <button data-testid="send">send</button>
    <button data-testid="drop">drop</button>
    <span data-testid="status"></span>
    <span data-testid="reconnects"></span>
    <span data-testid="on-subscribed"></span>
    <span data-testid="flow-ran"></span>
    <span data-testid="members-count"></span>
    <span data-testid="room-messages"></span>
  `);

  const socket = client<PersistenceClient>()(
    connect(wsUrl('persistence')),
    channels(),
    reconnection({ maxDelay: 400 }),
  );

  const room = socket.channel('archive-room');

  socket.subscribe(() => {
    el('status').textContent = socket.getState();
  });

  let reconnects = 0;
  socket.onReconnect(() => {
    reconnects += 1;
    el('reconnects').textContent = String(reconnects);
  });

  let onSubscribed = 0;
  function renderMembers(): void {
    el('members-count').textContent = String(room.members.size);
  }
  room.onSubscribed(() => {
    onSubscribed += 1;
    el('on-subscribed').textContent = String(onSubscribed);
    renderMembers();
  });
  room.onMemberJoin(renderMembers);
  room.onMemberLeave(renderMembers);

  // Top-level event the server sends from archive-room's onSubscribe hook.
  let flowRan = 0;
  socket.on('subscribe-flow-ran', () => {
    flowRan += 1;
    el('flow-ran').textContent = String(flowRan);
  });

  room.on('room-message', (msg) => {
    const line = `${msg.from}:${msg.text}`;
    const span = el('room-messages');
    span.textContent = span.textContent ? `${span.textContent},${line}` : line;
    renderMembers();
  });

  button('connect', () => socket.connect());
  button('sub', async () => {
    await room.subscribe();
  });
  button('send', () => {
    room.send('send-message', { text: 'witness ping' });
  });
  button('drop', () => {
    socket.send('server-drop', {});
  });

  el('reconnects').textContent = '0';
  el('on-subscribed').textContent = '0';
  el('flow-ran').textContent = '0';
  el('members-count').textContent = '0';
  ready();
}

setup();
