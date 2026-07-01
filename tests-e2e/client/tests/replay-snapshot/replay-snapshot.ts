import { client, connect, dedup, reconnection, replay } from '@wskit/client';
import type { ReplaySnapshotClient } from '@wskit/tests-e2e-handlers/replay-snapshot';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's replay() against the real `replay-snapshot` handler.
// replay() needs dedup() (it filters resent frames) and reconnection() (it only
// catches up after the socket comes back). After an unexpected drop the client
// auto-sends __replay__ and the server-replayed doc-snapshot frames arrive
// through the normal on() pipeline — snapshot mode keeps only the latest per key.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="update-a-first">update-a-first</button>
    <button data-testid="update-a-second">update-a-second</button>
    <button data-testid="update-b">update-b</button>
    <button data-testid="drop">drop</button>
    <span data-testid="status"></span>
    <span data-testid="reconnects"></span>
    <span data-testid="snapshots"></span>
  `);

  const socket = client<ReplaySnapshotClient>()(
    connect(wsUrl('replay-snapshot')),
    dedup(),
    replay(),
    // A short, fixed backoff: long enough for the spec to see 'reconnecting' and
    // let a witness send while we're down, short enough to replay before the
    // handler's maxAgeMs=1000 prunes the snapshot rows.
    reconnection({ maxDelay: 400 }),
  );

  // Latest title per docId, in the order keys first appeared, rendered as
  // "A:second-title | B:doc-b-title" so the spec can assert one entry per key.
  const latest = new Map<string, string>();

  function render(): void {
    el('snapshots').textContent = [...latest].map(([id, title]) => `${id}:${title}`).join(' | ');
  }

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  let reconnects = 0;
  socket.onReconnect(() => {
    reconnects += 1;
    el('reconnects').textContent = String(reconnects);
  });

  socket.on('doc-snapshot', (payload) => {
    latest.set(payload.docId, payload.title);
    render();
  });

  button('connect', () => socket.connect());

  button('update-a-first', () => {
    socket.send('update-doc', { docId: 'A', title: 'first-title' });
  });

  button('update-a-second', () => {
    socket.send('update-doc', { docId: 'A', title: 'second-title' });
  });

  button('update-b', () => {
    socket.send('update-doc', { docId: 'B', title: 'doc-b-title' });
  });

  // Ask the server to drop us with a retryable close code (a client-initiated
  // close isn't completed by the worker, so it never reconnects). reconnection()
  // then reopens in-session and replay() auto-catches-up.
  button('drop', () => {
    socket.send('server-drop', {});
  });

  el('reconnects').textContent = '0';
  ready();
}

setup();
