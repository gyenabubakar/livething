import { awareness, channels, client, connect, plugin, reconnection } from '@livething/client';
import type { AwarenessEntry } from '@livething/client';
import type { AwarenessClient, BoardsClient } from '@livething/tests-e2e-handlers/awareness';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

type RoomAwareness = { viewingMessageId: string | null };

// Drives @livething/client's `channel.awareness` against the real server definition: which
// message each member of Huddle's #general room is reading. Every store is rendered, so a
// spec reads `others`, `self`, `mine` and `synced` from the page, and every refusal and
// server error is listed, so it can tell `onRefused` from `onServerError`.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub">sub</button>
    <button data-testid="unsub">unsub</button>
    <button data-testid="view-msg-1">view-msg-1</button>
    <button data-testid="view-msg-2">view-msg-2</button>
    <button data-testid="clear">clear</button>
    <button data-testid="server-drop">server-drop</button>
    <span data-testid="status"></span>
    <span data-testid="status-log"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="others"></span>
    <span data-testid="others-sizes"></span>
    <span data-testid="self"></span>
    <span data-testid="mine"></span>
    <span data-testid="synced"></span>
    <span data-testid="refused"></span>
    <span data-testid="server-errors"></span>
  `);

  const Boards = plugin<BoardsClient>()({
    id: 'e2e:boards',
    dependencies: [channels, awareness],
    setup: (pluginSocket) => ({
      api: () => ({ general: pluginSocket.channel('boards', 'board:general') }),
    }),
  });

  const socket = client<AwarenessClient>()(
    connect(wsUrl('awareness')),
    channels(),
    awareness(),
    reconnection({ maxDelay: 400 }),
    Boards(),
  );

  // `?target=board` drives the same flows on the plugin's own channel family.
  const general =
    new URLSearchParams(location.search).get('target') === 'board'
      ? Boards.use(socket).general
      : socket.channel('rooms', 'room:general');

  function viewer(entry: AwarenessEntry<RoomAwareness>): string {
    return `${String(entry.meta.name)}=${entry.state.viewingMessageId}`;
  }

  function append(id: string, value: string): void {
    const prev = el(id).textContent;
    el(id).textContent = prev ? `${prev},${value}` : value;
  }

  // `others` holds the user's other tabs too, so each entry is shown by name and message.
  // Every published size is listed, so a spec can see whether `others` ever went empty.
  general.awareness.others.subscribe((others) => {
    el('others').textContent = [...others.values()].map(viewer).sort().join(',');
    append('others-sizes', String(others.size));
  });
  general.awareness.self.subscribe((self) => {
    el('self').textContent = self ? viewer(self) : '';
  });
  general.awareness.mine.subscribe((mine) => {
    el('mine').textContent = mine ? String(mine.viewingMessageId) : '';
  });
  el('synced').textContent = String(general.awareness.synced.get());
  general.awareness.synced.subscribe((synced) => {
    el('synced').textContent = String(synced);
  });

  general.awareness.onRefused((refusal) => append('refused', refusal.reason));
  socket.onServerError((error) => append('server-errors', error.code));

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
    append('status-log', socket.state.get());
  });

  button('connect', () => socket.connect());
  button('sub', async () => {
    await general.subscribe();
    el('subscribed').textContent = 'yes';
  });
  button('unsub', async () => {
    await general.unsubscribe();
    el('subscribed').textContent = 'no';
  });

  button('view-msg-1', () => general.awareness.set({ viewingMessageId: 'msg-1' }));
  button('view-msg-2', () => general.awareness.set({ viewingMessageId: 'msg-2' }));
  button('clear', () => general.awareness.clear());
  button('server-drop', () => {
    socket.send('server-drop', {});
  });

  ready();
}

setup();
