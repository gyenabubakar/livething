import { channels, client, connect, dedup, inbox, readReceipts, reconnection } from '@wskit/client';
import type { ReceiptsClient } from '@wskit/tests-e2e-handlers/receipts';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's delivered (inbox) and read (readReceipts) surfaces
// against the real handler. `__received__` advances the delivered cursor;
// markSeen() advances the seen cursor; both fan out as `__receipt__` frames
// feeding the local receipts store. `receivedBy(1)`/`seenBy(1)` round-trip over
// `__receiptQuery__`. `ask-cursor` returns the server's authoritative answer.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub">sub</button>
    <button data-testid="send">send</button>
    <button data-testid="mark-seen">mark-seen</button>
    <button data-testid="query-received">query-received</button>
    <button data-testid="query-seen">query-seen</button>
    <button data-testid="ask-server-received">ask-server-received</button>
    <button data-testid="ask-server-seen">ask-server-seen</button>
    <span data-testid="status"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="messages"></span>
    <span data-testid="receipt-view"></span>
    <span data-testid="query-received-result"></span>
    <span data-testid="query-seen-result"></span>
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

  // Live local view from the `__receipt__` fan-out: identity=receivedThrough:seenThrough.
  chat.receipts.subscribe(() => {
    const snapshot = chat.receipts.get();
    const rows = [...snapshot.values()]
      .sort((a, b) => a.identity.localeCompare(b.identity))
      .map(
        (r) => `${r.identity}=${r.receivedThrough > 0 ? 'r' : ''}${r.seenThrough > 0 ? 's' : ''}`,
      );
    el('receipt-view').textContent = rows.join(',');
  });

  button('connect', () => socket.connect());
  button('sub', async () => {
    await chat.subscribe();
    el('subscribed').textContent = 'yes';
  });
  button('send', () => {
    chat.send('send-room-msg', { text: 'hello' });
  });
  button('mark-seen', () => {
    chat.markSeen();
  });

  button('query-received', async () => {
    const identities = await chat.receivedBy(1);
    el('query-received-result').textContent = identities.slice().sort().join('|');
  });
  button('query-seen', async () => {
    const identities = await chat.seenBy(1);
    el('query-seen-result').textContent = identities.slice().sort().join('|');
  });

  button('ask-server-received', () => {
    chat.send('ask-cursor', { kind: 'received', seq: 1 });
  });
  button('ask-server-seen', () => {
    chat.send('ask-cursor', { kind: 'seen', seq: 1 });
  });

  ready();
}

setup();
