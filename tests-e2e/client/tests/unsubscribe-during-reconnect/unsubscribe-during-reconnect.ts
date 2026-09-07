import { channels, client, connect, reconnection } from '@wskit/client';
import type { PersistenceClient } from '@wskit/tests-e2e-handlers/persistence';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client against the real `persistence` handler to prove that an
// unsubscribe() issued WHILE the socket is reconnecting is not lost: the client
// resends the __unsubscribe__ on reopen, suppresses the persistent channel's
// auto-rejoin, and the server truly removes the member and confirms it with
// __unsubscribeOk__ (so the unsubscribe() promise resolves). Reuses the
// persistence handler's archive-room (persistent), server-drop (warm reconnect),
// subscribe-flow-ran (counts subscribe flows), and true-leave (a real leave).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub-archive">sub-archive</button>
    <button data-testid="server-drop">server-drop</button>
    <button data-testid="unsubscribe">unsubscribe</button>
    <button data-testid="send-after-leave">send-after-leave</button>
    <span data-testid="status"></span>
    <span data-testid="send-result"></span>
    <span data-testid="leave-result"></span>
    <span data-testid="archive-subscribed"></span>
    <span data-testid="unsubscribed"></span>
    <span data-testid="subscribe-flows"></span>
    <span data-testid="true-leaves"></span>
    <span data-testid="members"></span>
  `);

  const socket = client<PersistenceClient>()(
    connect(wsUrl('persistence')),
    channels(),
    reconnection(),
  );

  const archive = socket.channel('archive-room');

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  // Count the subscribe flows the server actually ran for this identity. A second
  // flow after reconnect would mean the unsubscribe failed and the channel rejoined.
  let flows = 0;
  socket.on('subscribe-flow-ran', () => {
    flows += 1;
    el('subscribe-flows').textContent = String(flows);
  });

  let leaves = 0;
  socket.on('true-leave', () => {
    leaves += 1;
    el('true-leaves').textContent = String(leaves);
  });

  let unsubscribed = 0;
  archive.onUnsubscribed(() => {
    unsubscribed += 1;
    el('unsubscribed').textContent = String(unsubscribed);
  });

  function renderMembers(): void {
    el('members').textContent = String(archive.members.get().size);
  }

  archive.onMemberJoin(renderMembers);
  archive.onMemberLeave(renderMembers);

  button('connect', () => socket.connect());

  button('sub-archive', async () => {
    await archive.subscribe();
    el('archive-subscribed').textContent = 'yes';
    renderMembers();
  });

  // Server-initiated retryable close: the socket goes to 'reconnecting'.
  button('server-drop', () => {
    socket.send('server-drop', {});
  });

  // Called while the socket is reconnecting — the leave is held and resent on open.
  // The promise resolves only when the server's __unsubscribeOk__ confirms it.
  button('unsubscribe', () => {
    archive.unsubscribe().then(
      () => {
        el('leave-result').textContent = 'resolved';
      },
      (err) => {
        el('leave-result').textContent = errorCode(err) || 'rejected';
      },
    );
  });

  // After the leave, a send must fail locally — the channel is inactive even if a
  // stale server auto-rejoin confirmation arrived late.
  button('send-after-leave', () => {
    try {
      archive.send('send-message', { text: 'late' });
      el('send-result').textContent = 'sent';
    } catch (err) {
      el('send-result').textContent = errorCode(err);
    }
  });

  el('subscribe-flows').textContent = '0';
  el('true-leaves').textContent = '0';
  el('unsubscribed').textContent = '0';
  el('leave-result').textContent = 'pending';
  ready();
}

setup();
