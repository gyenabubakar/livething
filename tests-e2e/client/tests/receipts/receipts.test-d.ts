import { channels, client, connect, dedup, inbox, readReceipts } from '@wskit/client';
import type { ReceiptsClient } from '@wskit/tests-e2e-handlers/receipts';

// Type-only proof that @wskit/client surfaces the receipt methods on a channel
// whose contract sets both flags. tsc checks this file; nothing runs it. The
// puppet package has no vitest, so the checks are dependency-free — each call
// below only compiles if the method is present with the expected signature.
const socket = client<ReceiptsClient>()(
  connect('wss://example.test/ws'),
  channels(),
  inbox(),
  readReceipts(),
  dedup(),
);

const chat = socket.channel('chat');

// inbox() adds receivedBy + receipts; readReceipts() adds markSeen + seenBy.
const _receivedBy: Promise<string[]> = chat.receivedBy(1);
const _seenBy: Promise<string[]> = chat.seenBy(1);
chat.markSeen(1);
chat.markSeen();
const _receipts = chat.receipts;
const _onReceipt: () => void = chat.onReceipt(() => {});

export type {};
