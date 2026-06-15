import { computeBroadcastScopeKey } from '~/_engine/stream-durable/types.ts';
import { describe, expect, it } from 'vitest';
import type { ResolvedScope } from '~/_engine/runtime/types.ts';

function chf(channelScope: string, channelName: string): string {
  return computeBroadcastScopeKey({ channelScope, channelName } as unknown as ResolvedScope);
}

describe('computeBroadcastScopeKey — channel-family keys never collide', () => {
  it('same scope + name always produces the same key', () => {
    expect(chf('rooms', 'room:abc')).toBe(chf('rooms', 'room:abc'));
  });

  // Distinct (scope, name) pairs that a plain-delimiter key would collapse to
  // the same string, because both parts may contain ':'. JSON encoding keeps
  // them apart since ':' lives inside quoted, escaped strings.
  const trickyPairs: ReadonlyArray<readonly [[string, string], [string, string]]> = [
    [
      ['a', 'b:c'],
      ['a:b', 'c'],
    ],
    [
      ['a:', 'b'],
      ['a', ':b'],
    ],
    [
      ['a', 'b"],["x'],
      ['a', 'b"]],[["x'],
    ],
  ];

  it.each(trickyPairs)('does not collide: %j vs %j', (left, right) => {
    expect(chf(left[0], left[1])).not.toBe(chf(right[0], right[1]));
  });

  it('non-family channel and top-level keys are unchanged', () => {
    expect(computeBroadcastScopeKey({ channelName: 'room:abc' } as unknown as ResolvedScope)).toBe(
      '__bcast:ch:room:abc__',
    );
    expect(computeBroadcastScopeKey({} as unknown as ResolvedScope)).toBe('__bcast:top__');
  });
});
