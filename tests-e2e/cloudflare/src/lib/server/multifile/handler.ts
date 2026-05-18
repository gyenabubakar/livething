// Coverage: multi-file composition. The contract lives in setup.ts, the room
// channel handlers live in rooms.ts as a group, and this file mounts the group
// via `.use()` plus an inline lifecycle hook. If primitives or type state
// didn't survive the file boundary, either the channel wouldn't dispatch or
// this file would stop type-checking.
import { implement } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import { rooms } from './rooms.ts';
import { multifileContract } from './setup.ts';

export const multifileHandler = implement(multifileContract)
  .onUpgrade((request) => requireUsername(request))
  .use(rooms)
  .onConnect((ctx) => {
    ctx.send('notification', { title: `welcome ${ctx.meta.username}` });
  })
  .build();
