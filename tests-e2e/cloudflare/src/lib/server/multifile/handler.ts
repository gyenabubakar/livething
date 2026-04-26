// Coverage: multi-file composition. `base` lives in setup.ts and `rooms` lives
// in rooms.ts. Both are imported here, the channel primitive is mounted via
// .use(), and a flat lifecycle hook is added inline. .build() ties everything
// together. If primitives or type state didn't survive the file boundary,
// either the channel wouldn't dispatch or this file would stop type-checking.
import { rooms } from './rooms.ts';
import { base } from './setup.ts';

export const multifileHandler = base
  .use(rooms)
  .onConnect((ctx) => {
    ctx.send('notification', { title: `welcome ${ctx.meta.username}` });
  })
  .build();
