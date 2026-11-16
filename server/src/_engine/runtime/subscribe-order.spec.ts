import { describe, expect, it } from 'vitest';
import { subscribeKey } from './subscribe-order.ts';

describe('subscribeKey', () => {
  it('gives each channel its own key when calls switch between channels', () => {
    const calls: [string, string | null][] = [
      ['room:general', 'room'],
      ['room:general', 'room'],
      ['room:general', null],
      ['room:general', ''],
      ['room:random', 'room'],
      ['room:general', 'room'],
      ['lobby', null],
      ['lobby', null],
    ];

    for (const [name, family] of calls) {
      expect(subscribeKey(name, family)).toBe(JSON.stringify([family, name]));
    }
  });
});
