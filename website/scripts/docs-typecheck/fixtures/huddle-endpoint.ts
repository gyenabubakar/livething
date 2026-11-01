// The Huddle endpoint that the Node adapter pages create in their own files and import elsewhere.
import { setup } from '@livething/server-node';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { huddle } from './huddle-definition';

export const huddleNode = setup();
export const huddleEndpoint = huddleNode.bind(huddle, { sql: './data/huddle.sqlite' });
export declare function handleHuddleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean;
