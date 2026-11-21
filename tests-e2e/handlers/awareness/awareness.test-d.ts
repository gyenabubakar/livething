import type { RoomAwareness } from './events.ts';
import type { AwarenessClient, BoardsClient } from './handler.ts';

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

// The plugin's board family has it too: under its wire name for the host, and under its
// plain name for the plugin.
type _HostBoardsHaveAwareness = Expect<
  Equal<AwarenessClient['channels']['__e2e:boards::boards']['awareness'], RoomAwareness>
>;
type _PluginBoardsHaveAwareness = Expect<
  Equal<BoardsClient['channels']['boards']['awareness'], RoomAwareness>
>;

export type {};
