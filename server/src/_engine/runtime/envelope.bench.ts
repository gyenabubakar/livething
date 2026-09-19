/* oxlint-disable @typescript-eslint/no-explicit-any -- bench harness */
import * as v from 'valibot';
import { bench, describe } from 'vitest';
import { parseUserEventFrame, UserEventFrameSchema } from './protocol.ts';
import { resolveChannel } from './scope.ts';

const plain = JSON.stringify(['chat', { text: 'hello world' }, null]);
const withLiveThing = JSON.stringify([
  'chat',
  { text: 'hello world' },
  { channel: { name: 'room:1' }, delivery: { id: 'm-0123456789abcdef', seq: 42 } },
]);
const plainObj = JSON.parse(plain);
const withLiveThingObj = JSON.parse(withLiveThing);

describe('C1 — envelope validation per user message', () => {
  bench('JSON.parse only (unavoidable) — with __livething', () => {
    JSON.parse(withLiveThing);
  });
  bench('valibot v.parse — with __livething', () => {
    v.parse(UserEventFrameSchema, withLiveThingObj);
  });
  bench('shipped parseUserEventFrame — with __livething', () => {
    parseUserEventFrame(withLiveThingObj);
  });
  bench('valibot v.parse — plain frame', () => {
    v.parse(UserEventFrameSchema, plainObj);
  });
  bench('shipped parseUserEventFrame — plain frame', () => {
    parseUserEventFrame(plainObj);
  });
});

const compiled = {
  channels: new Map<string, unknown>([['room:1', {}]]),
  channelFamilies: new Map<string, unknown>([['room', { pattern: { pattern: /^room:.+$/ } }]]),
} as any;
const staticLiveThing = { channel: 'room:1', channelFamily: null } as any;
const familyLiveThing = { channel: 'room:42', channelFamily: 'room' } as any;

describe('C2 — resolveChannel per channel frame (2 calls today → 1)', () => {
  bench('static channel — current (2 calls)', () => {
    resolveChannel(compiled, staticLiveThing);
    resolveChannel(compiled, staticLiveThing);
  });
  bench('static channel — deduped (1 call)', () => {
    resolveChannel(compiled, staticLiveThing);
  });
  bench('dynamic family — current (2 calls)', () => {
    resolveChannel(compiled, familyLiveThing);
    resolveChannel(compiled, familyLiveThing);
  });
  bench('dynamic family — deduped (1 call)', () => {
    resolveChannel(compiled, familyLiveThing);
  });
});
