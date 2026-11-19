// What a short docs example may use without declaring it: Huddle itself. Every name is real and
// typed, so a short example is checked against the same app as the long ones.
import {
  awareness,
  binary,
  channels,
  client,
  clientRequests,
  connect,
  dedup,
  gaps,
  inbox,
  keepalive,
  platform,
  readReceipts,
  reconnection,
  replay,
  serverRequests,
  stream,
  uploads,
} from '@livething/client';
import { WebEnvironment } from '@livething/client/environment';
import { emits, server, t } from '@livething/server';
import type { AppCtx } from '@livething/server';
import { base, dms, Message, rooms, Status } from './base';
import { huddle } from './huddle-definition';
import type { HuddleSocket } from './huddle-definition';

export { base, dms, emits, huddle, Message, rooms, server, Status, t };
export type { HuddleSocket };
export { client, connect };

type CtxOf<B> = B extends { on(event: any, config: { run(ctx: infer C, input: any): any }): any }
  ? C
  : never;
export declare const ctx: CtxOf<typeof base> extends never
  ? AppCtx<any, any, any>
  : CtxOf<typeof base>;

export const socket = client<HuddleSocket>()(
  connect('wss://huddle.example.com/huddle'),
  binary(),
  uploads(),
  channels(),
  awareness(),
  clientRequests(),
  serverRequests(),
  stream(),
  inbox(),
  readReceipts(),
  dedup(),
  replay(),
  gaps(),
  keepalive(),
  platform({ environment: WebEnvironment }),
  reconnection(),
);

export const general = socket.channel('rooms', 'room:general');
export const room = general;
export const dm = socket.channel('dms', 'dm:ama+kofi');
