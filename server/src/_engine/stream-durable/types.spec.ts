import { computeBroadcastKey } from '~/_engine/stream-durable/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { ResolvedChannel } from '~/_engine/runtime/types.ts';

function chf(channelFamily: string, channelName: string): string {
  return computeBroadcastKey({ channelFamily, channelName } as unknown as ResolvedChannel);
}

describe('computeBroadcastKey — channel-family keys never collide', () => {
  it('same family + name always produces the same key', () => {
    expect(chf('rooms', 'room:abc')).toBe(chf('rooms', 'room:abc'));
  });

  // Distinct (family, name) pairs that a plain-delimiter key would collapse to
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
    expect(computeBroadcastKey({ channelName: 'room:abc' } as unknown as ResolvedChannel)).toBe(
      '__bcast:ch:room:abc__',
    );
    expect(computeBroadcastKey({} as unknown as ResolvedChannel)).toBe('__bcast:top__');
  });
});
