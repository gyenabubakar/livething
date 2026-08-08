/* oxlint-disable @typescript-eslint/no-explicit-any -- bench harness */
import * as v from 'valibot';
import { bench, describe } from 'vitest';
import { parseUserEventFrame, UserEventFrameSchema } from './protocol.ts';
import { resolveChannel } from './scope.ts';

const plain = JSON.stringify({ event: 'chat', payload: { text: 'hello world' } });
const withWskit = JSON.stringify({
  event: 'chat',
  payload: { text: 'hello world' },
  __wskit: { channel: 'room:1', messageId: 'm-0123456789abcdef', seq: 42 },
});
const plainObj = JSON.parse(plain);
const withWskitObj = JSON.parse(withWskit);

describe('C1 — envelope validation per user message', () => {
  bench('JSON.parse only (unavoidable) — with __wskit', () => {
    JSON.parse(withWskit);
  });
  bench('valibot v.parse — with __wskit', () => {
    v.parse(UserEventFrameSchema, withWskitObj);
  });
  bench('shipped parseUserEventFrame — with __wskit', () => {
    parseUserEventFrame(withWskitObj);
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
const staticWskit = { channel: 'room:1', channelFamily: null } as any;
const familyWskit = { channel: 'room:42', channelFamily: 'room' } as any;

describe('C2 — resolveChannel per channel frame (2 calls today → 1)', () => {
  bench('static channel — current (2 calls)', () => {
    resolveChannel(compiled, staticWskit);
    resolveChannel(compiled, staticWskit);
  });
  bench('static channel — deduped (1 call)', () => {
    resolveChannel(compiled, staticWskit);
  });
  bench('dynamic family — current (2 calls)', () => {
    resolveChannel(compiled, familyWskit);
    resolveChannel(compiled, familyWskit);
  });
  bench('dynamic family — deduped (1 call)', () => {
    resolveChannel(compiled, familyWskit);
  });
});
