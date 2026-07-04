import type { ReceiptsClient } from './handler.ts';

// Type-only: tsc checks these; nothing runs them. The receipts `chat` channel
// enables both surfaces, so it carries BOTH client-contract flags: `inbox: true`
// (receivedBy/onReceipt/receipts) and `readReceipts: true` (markSeen/seenBy).
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type ChatChannel = ReceiptsClient['channels']['chat'];

type _InboxIsTrue = Expect<Equal<ChatChannel['inbox'], true>>;
type _ReadReceiptsIsTrue = Expect<Equal<ChatChannel['readReceipts'], true>>;

export type {};
