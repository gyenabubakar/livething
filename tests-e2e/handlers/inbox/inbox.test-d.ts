import type { InboxClient } from './handler.ts';

// Type-only: tsc checks these; nothing runs them. A broken assumption is a build
// error. The inbox `chat` channel carries the `inbox: true` client-contract flag
// (so the client's inbox() exposes receivers/receiversOf/onReceived) and NOT
// `readReceipts` (no markAsRead/readers/readersOf).
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type ChatChannel = InboxClient['channels']['chat'];

type _InboxIsTrue = Expect<Equal<ChatChannel['inbox'], true>>;
type _NoReadReceipts = Expect<'readReceipts' extends keyof ChatChannel ? false : true>;

export type {};
