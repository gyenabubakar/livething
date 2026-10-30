// Coverage: multi-file composition / assembly. The base lives in
// setup.ts, the lobby channel and its handler live in rooms.ts, and this file
// assembles the channel handler (which drags the whole channel in). The connect
// lifecycle hook lives in setup.ts, in the base config. If primitives or type
// state didn't survive the file boundary, either the channel wouldn't dispatch
// or this file would stop type-checking.
import type { InferClient } from '@livething/server';
import { handleSendRoomMessage } from './rooms.ts';
import { base } from './setup.ts';

export const multifileDefinition = base.assemble({ handlers: [handleSendRoomMessage] });

export type MultifileClient = InferClient<typeof multifileDefinition>;
