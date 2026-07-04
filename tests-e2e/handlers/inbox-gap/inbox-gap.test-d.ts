import type { InboxGapClient } from './handler.ts';

// Type-only: tsc checks these; nothing runs them. The inbox-gap `chat` channel
// is inbox-backed with overflow retention, so it carries `inbox: true` and NOT
// `readReceipts` — overflow is an inbox concern, read receipts are not enabled.
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type ChatChannel = InboxGapClient['channels']['chat'];

type _InboxIsTrue = Expect<Equal<ChatChannel['inbox'], true>>;
type _NoReadReceipts = Expect<'readReceipts' extends keyof ChatChannel ? false : true>;

export type {};
