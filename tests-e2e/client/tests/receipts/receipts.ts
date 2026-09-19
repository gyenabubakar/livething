import {
  channels,
  client,
  connect,
  dedup,
  inbox,
  readReceipts,
  reconnection,
} from '@livething/client';
import type { ReceiptsClient } from '@livething/tests-e2e-handlers/receipts';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @livething/client's received (inbox) and read (readReceipts) surfaces
// against the real server definition. `__received__` advances the received cursor and fans
// out as a `__received__` frame feeding the `receivers` store; markAsRead()
// advances the read cursor and fans out as a `__read__` frame feeding `readers`.
// `receiversOf(1)`/`readersOf(1)` round-trip over `__receivedQuery__` /
// `__readQuery__`. `ask-cursor` returns the server's authoritative answer.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub">sub</button>
    <button data-testid="send">send</button>
    <button data-testid="mark-read">mark-read</button>
    <button data-testid="query-received">query-received</button>
    <button data-testid="query-read">query-read</button>
    <button data-testid="ask-server-received">ask-server-received</button>
    <button data-testid="ask-server-read">ask-server-read</button>
    <span data-testid="status"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="messages"></span>
    <span data-testid="receivers-view"></span>
    <span data-testid="readers-view"></span>
    <span data-testid="query-received-result"></span>
    <span data-testid="query-read-result"></span>
    <span data-testid="server-answer"></span>
  `);

  const socket = client<ReceiptsClient>()(
    connect(wsUrl('receipts')),
    channels(),
    inbox(),
    readReceipts(),
    dedup(),
    reconnection({ maxDelay: 400 }),
  );

  const chat = socket.channel('chat');

  chat.on('room-msg', (msg) => {
    const prev = el('messages').textContent;
    el('messages').textContent = prev ? `${prev},${msg.text}` : msg.text;
  });

  socket.on('cursor-answer', (answer) => {
    el('server-answer').textContent = `${answer.kind}:${answer.identities
      .slice()
      .sort()
      .join('|')}`;
  });

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  // The received / read cursor stores rendered as identity=cursor lists.
  function renderCursors(list: ReadonlyMap<string, number>): string {
    return [...list.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([identity, seq]) => `${identity}=${seq}`)
      .join(',');
  }

  chat.receivers.subscribe(() => {
    el('receivers-view').textContent = renderCursors(chat.receivers.get());
  });
  chat.readers.subscribe(() => {
    el('readers-view').textContent = renderCursors(chat.readers.get());
  });

  button('connect', () => socket.connect());
  button('sub', async () => {
    await chat.subscribe();
    el('subscribed').textContent = 'yes';
  });
  button('send', () => {
    chat.send('send-room-msg', { text: 'hello' });
  });
  button('mark-read', () => {
    chat.markAsRead();
  });

  button('query-received', async () => {
    const identities = await chat.receiversOf(1);
    el('query-received-result').textContent = identities.slice().sort().join('|');
  });
  button('query-read', async () => {
    const identities = await chat.readersOf(1);
    el('query-read-result').textContent = identities.slice().sort().join('|');
  });

  button('ask-server-received', () => {
    chat.send('ask-cursor', { kind: 'received', seq: 1 });
  });
  button('ask-server-read', () => {
    chat.send('ask-cursor', { kind: 'read', seq: 1 });
  });

  ready();
}

setup();
