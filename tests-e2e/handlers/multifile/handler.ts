// Coverage: multi-file composition / assembly. The base lives in
// setup.ts, the lobby channel and its handler live in rooms.ts, and this file
// assembles the channel handler (which drags the whole channel in) plus an
// inline connect lifecycle hook. If primitives or type state didn't survive the
// file boundary, either the channel wouldn't dispatch or this file would stop
// type-checking.
import type { InferClient } from '@wskit/server';
import { handleSendRoomMessage } from './rooms.ts';
import { base } from './setup.ts';

base.connect((ctx) => {
  ctx.send('notification', { title: `welcome ${ctx.meta.username}` });
});

export const multifileHandler = base.assemble(handleSendRoomMessage);

export type MultifileClient = InferClient<typeof multifileHandler>;
