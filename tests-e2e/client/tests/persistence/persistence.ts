import { channels, client, connect } from '@wskit/client';
import type { PersistenceClient } from '@wskit/tests-e2e-handlers/persistence';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's channels() against the real `persistence` server definition. The
// spec reloads the page to get a COLD client (one that never re-subscribes), so
// the engine's server-driven auto-rejoin of a persistent channel (archive-room)
// is observable: onSubscribed fires with source 'server', members repopulates,
// and a witness broadcast reaches the rejoined socket with no client subscribe.
// A non-persistent channel (typing-indicator) does NOT auto-rejoin.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub-archive">sub-archive</button>
    <button data-testid="sub-typing">sub-typing</button>
    <button data-testid="send-archive">send-archive</button>
    <span data-testid="status"></span>
    <span data-testid="archive-subscribed"></span>
    <span data-testid="typing-subscribed"></span>
    <span data-testid="server-rejoins"></span>
    <span data-testid="typing-server-rejoins"></span>
    <span data-testid="members-count"></span>
    <span data-testid="room-messages"></span>
  `);

  const socket = client<PersistenceClient>()(connect(wsUrl('persistence')), channels());

  const archive = socket.channel('archive-room');
  const typing = socket.channel('typing-indicator');

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  // The members store publishes on every roster change, including the
  // __memberSync__ that repopulates it after a server-driven rejoin — even when
  // no member actually changed, which onMemberJoin would not report. Binding the
  // count to the store is what lets the reconnect repopulation stay observable.
  archive.members.subscribe((members) => {
    el('members-count').textContent = String(members.size);
  });

  // Count only the server-initiated (auto-rejoin) subscriptions; the initial
  // client subscribe reports source 'client'.
  let serverRejoins = 0;
  archive.onSubscribed((source) => {
    if (source === 'server') {
      serverRejoins += 1;
      el('server-rejoins').textContent = String(serverRejoins);
    }
  });

  let typingServerRejoins = 0;
  typing.onSubscribed((source) => {
    if (source === 'server') {
      typingServerRejoins += 1;
      el('typing-server-rejoins').textContent = String(typingServerRejoins);
    }
  });

  archive.on('room-message', (msg) => {
    const line = `${msg.from}:${msg.text}`;
    const span = el('room-messages');
    span.textContent = span.textContent ? `${span.textContent},${line}` : line;
  });

  button('connect', () => socket.connect());

  button('sub-archive', async () => {
    await archive.subscribe();
    el('archive-subscribed').textContent = 'yes';
  });

  button('sub-typing', async () => {
    await typing.subscribe();
    el('typing-subscribed').textContent = 'yes';
  });

  button('send-archive', () => {
    archive.send('send-message', { text: 'hello rejoined alice' });
  });

  el('server-rejoins').textContent = '0';
  el('typing-server-rejoins').textContent = '0';
  ready();
}

setup();
