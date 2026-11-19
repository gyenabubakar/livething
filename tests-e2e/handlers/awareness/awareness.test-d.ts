import type { RoomAwareness } from './events.ts';
import type { AwarenessClient } from './handler.ts';

// Type-only: tsc checks these; nothing runs them. The `rooms` family has the awareness
// option, so its client contract carries the state type. The `lobby` has none.
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type RoomsChannel = AwarenessClient['channels']['rooms'];
type LobbyChannel = AwarenessClient['channels']['lobby'];

type _RoomsHaveAwareness = Expect<Equal<RoomsChannel['awareness'], RoomAwareness>>;
type _LobbyHasNoAwareness = Expect<
  Equal<'awareness' extends keyof LobbyChannel ? true : false, false>
>;

export type {};
