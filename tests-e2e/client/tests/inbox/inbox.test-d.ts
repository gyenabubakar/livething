import { channels, client, connect, dedup, inbox } from '@livething/client';
import type { InboxClient } from '@livething/tests-e2e-handlers/inbox';

// Type-only proof that @livething/client surfaces inbox() methods but NOT
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

// inbox() adds receiversOf + receivers + onReceived.
const _receiversOf: Promise<string[]> = chat.receiversOf(1);
const _receivers: ReadonlyMap<string, number> = chat.receivers.get();
const _onReceived: () => void = chat.onReceived(() => {});

// readReceipts() is NOT applied, so markAsRead / readersOf must be absent.
// @ts-expect-error — markAsRead only exists on a readReceipts channel
chat.markAsRead(1);
// @ts-expect-error — readersOf only exists on a readReceipts channel
chat.readersOf(1);

export type {};
