import { channels, client, connect, reconnection } from '@livething/client';
import type { PersistenceClient } from '@livething/tests-e2e-handlers/persistence';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Watches the roster and presence events of the PERSISTENT archive-room. The
// members list shows the roster keys, the online list shows the members whose
// `online` flag is set, and the log records every presence callback with the
// member id it carried, so a spec can check that a peer keeps one stable id
// across its reconnects and tabs.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub">sub</button>
    <button data-testid="unsub">unsub</button>
    <button data-testid="drop">drop</button>
    <button data-testid="kick-alice">kick alice</button>
    <span data-testid="status"></span>
    <span data-testid="on-subscribed"></span>
    <span data-testid="members"></span>
    <span data-testid="online"></span>
    <span data-testid="log"></span>
  `);

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

  room.members.subscribe((members) => {
    const ids = [...members.keys()].sort();
    el('members').textContent = ids.join(',');
    el('online').textContent = ids.filter((id) => members.get(id)?.online).join(',');
  });

  function log(entry: string): void {
    const span = el('log');
    span.textContent = span.textContent ? `${span.textContent},${entry}` : entry;
  }

  room.onMemberJoin((memberId) => log(`join:${memberId}`));
  room.onMemberLeave((memberId) => log(`leave:${memberId}`));
  room.onMemberOnline((memberId) => log(`online:${memberId}`));
  room.onMemberOffline((memberId) => log(`offline:${memberId}`));

  button('connect', () => socket.connect());
  button('sub', async () => {
    await room.subscribe();
  });
  button('unsub', async () => {
    await room.unsubscribe();
  });
  button('drop', () => {
    socket.send('server-drop', {});
  });
  button('kick-alice', () => {
    socket.send('kick-member', { identity: 'alice' });
  });

  el('on-subscribed').textContent = '0';
  ready();
}

setup();
