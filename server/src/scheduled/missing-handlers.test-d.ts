import { server } from '~/_define/server.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { expectTypeOf } from 'vitest';

const huddleBase = server({
  capabilities: [scheduled({ sendDigest: null, archiveRooms: null })],
});

type MissingHandlersMessage = Parameters<
  typeof huddleBase.assemble<readonly [], unknown>
>[0]['handlers'];

type IsUnion<T, TAll = T> = T extends unknown ? ([TAll] extends [T] ? false : true) : never;

expectTypeOf<IsUnion<MissingHandlersMessage>>().toEqualTypeOf<false>();

expectTypeOf<
  Extract<
    MissingHandlersMessage,
    | `${string}'sendDigest'${string}'archiveRooms'${string}`
    | `${string}'archiveRooms'${string}'sendDigest'${string}`
  >
>().toEqualTypeOf<never>();

expectTypeOf<MissingHandlersMessage>().toExtend<
  `${string}'sendDigest'${string}` | `${string}'archiveRooms'${string}`
>();
