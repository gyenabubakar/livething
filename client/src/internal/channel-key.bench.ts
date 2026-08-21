import { channelKey } from '~/internal/channel-key.ts';
import { bench, describe } from 'vitest';

const names = Array.from({ length: 64 }, (_, i) => `room-${i}`);
const families = ['thread', 'dm', undefined] as const;

// Every inbound channel frame builds one of these to find its channel state,
// and inbox/read-receipts/replay each build one more for the same frame.
describe('channelKey · 100k lookups', () => {
  bench('static channel (no family)', () => {
    for (let i = 0; i < 100_000; i++) channelKey(undefined, names[i & 63]!);
  });

  bench('family-scoped channel', () => {
    for (let i = 0; i < 100_000; i++) channelKey(families[i % 2]!, names[i & 63]!);
  });

  bench('used as a map key', () => {
    const states = new Map<string, number>();
    for (let i = 0; i < 100_000; i++) {
      const key = channelKey(families[i % 3], names[i & 63]!);
      states.set(key, (states.get(key) ?? 0) + 1);
    }
  });
});
