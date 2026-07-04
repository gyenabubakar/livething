import { channels, client, connect, dedup, inbox } from '@wskit/client';
import type { InboxClient } from '@wskit/tests-e2e-handlers/inbox';

// Type-only proof that @wskit/client surfaces inbox() methods but NOT
// readReceipts() ones on a channel whose contract sets only `inbox: true`. tsc
// checks this file; nothing runs it. The `@ts-expect-error` lines are the
// negatives — they only pass if the method is genuinely absent from the type.
const socket = client<InboxClient>()(
  connect('wss://example.test/ws'),
  channels(),
  inbox(),
  dedup(),
);

const chat = socket.channel('chat');

// inbox() adds receivedBy + receipts + onReceipt.
const _receivedBy: Promise<string[]> = chat.receivedBy(1);
const _receipts = chat.receipts;
const _onReceipt: () => void = chat.onReceipt(() => {});

// readReceipts() is NOT applied, so markSeen / seenBy must be absent.
// @ts-expect-error — markSeen only exists on a readReceipts channel
chat.markSeen(1);
// @ts-expect-error — seenBy only exists on a readReceipts channel
chat.seenBy(1);

export type {};
