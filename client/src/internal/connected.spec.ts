import { describe, expect, it } from 'vitest';
import { parseConnectedInfo } from './connected.ts';

const valid = {
  pingIntervalMs: 20_000,
  idleTimeoutMs: 60_000,
  maxResumeTokens: 5,
  connectionId: 'conn_8f2c',
  features: ['replay'],
  resume: { token: 'r_3a9d', seq: 12 },
};

describe('parseConnectedInfo', () => {
  it('reads a frame within the wire protocol bounds', () => {
    expect(parseConnectedInfo(valid)).toEqual(valid);
    expect(
      parseConnectedInfo({ ...valid, pingIntervalMs: null, idleTimeoutMs: null, resume: null }),
    ).not.toBeNull();
  });

  // A negative ping interval would start a timer that fires every millisecond.
  it.each([
    ['a negative ping interval', { pingIntervalMs: -5 }],
    ['a fractional idle timeout', { idleTimeoutMs: 1.5 }],
    ['an unsafe integer', { pingIntervalMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['a negative maxResumeTokens', { maxResumeTokens: -1 }],
    ['an empty resume token', { resume: { token: '', seq: 1 } }],
    ['a resume token over 64 characters', { resume: { token: 'r'.repeat(65), seq: 1 } }],
    ['a negative resume seq', { resume: { token: 'r_3a9d', seq: -3 } }],
  ])('refuses %s', (_name, change) => {
    expect(parseConnectedInfo({ ...valid, ...change })).toBeNull();
  });
});
