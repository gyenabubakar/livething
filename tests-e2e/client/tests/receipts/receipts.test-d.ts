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

// inbox() adds receiversOf + receivers + onReceived; readReceipts() adds
// markAsRead + readersOf + readers + onRead.
const _receiversOf: Promise<string[]> = chat.receiversOf(1);
const _readersOf: Promise<string[]> = chat.readersOf(1);
chat.markAsRead(1);
chat.markAsRead();
const _receivers: ReadonlyMap<string, number> = chat.receivers.get();
const _readers: ReadonlyMap<string, number> = chat.readers.get();
const _onReceived: () => void = chat.onReceived(() => {});
const _onRead: () => void = chat.onRead(() => {});

export type {};
