import { eachPart, joinBytes } from '~/doc/parts.ts';
import { describe, expect, it } from 'vitest';

describe('eachPart', () => {
  it('splits an update into parts of the size given, and joinBytes puts them back', () => {
    const update = Uint8Array.from({ length: 10 }, (_, index) => index);
    const parts: [Uint8Array, unknown][] = [];

    eachPart(update, 4, (bytes, part) => parts.push([bytes, part]));

    expect(parts.map(([, part]) => part)).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(joinBytes(parts.map(([bytes]) => bytes))).toEqual(update);
  });

  it('sends an update that fits one part as it is', () => {
    const sent: unknown[] = [];

    eachPart(new Uint8Array(4), 4, (_, part) => sent.push(part));

    expect(sent).toEqual([null]);
  });

  it('refuses a part size under 1 byte, which would never end', () => {
    expect(() => eachPart(new Uint8Array(4), 0, () => {})).toThrow(RangeError);
  });
});
