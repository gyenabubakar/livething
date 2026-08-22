import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { TranslationInputError, translator } from './translator.ts';

describe('translator()', () => {
  it('creates independent state for each connection', () => {
    const factory = translator(() => {
      let count = 0;
      return {
        inbound(raw) {
          count += 1;
          return `${raw}:${count}`;
        },
      };
    });

    const first = factory();
    const second = factory();

    expect(first.inbound('first')).toBe('first:1');
    expect(first.inbound('second')).toBe('second:2');
    expect(second.inbound('other')).toBe('other:1');
  });

  it('validates JSON input before calling inbound', () => {
    const parse = translator(() => ({
      input: v.object({ event: v.string() }),
      inbound(frame) {
        return frame.event;
      },
    }));

    expect(parse().inbound('{"event":"joined"}')).toBe('joined');
    expect(() => parse().inbound('{"event":1}')).toThrow(TranslationInputError);
    expect(() => parse().inbound('not json')).toThrow(TranslationInputError);
  });

  it('requires translated values to be strings or null', () => {
    const invalid = translator(
      () =>
        ({
          inbound() {
            return { event: 'wrong' };
          },
        }) as never,
    );

    expect(() => invalid().inbound('frame')).toThrow(/must return a string or null/);
  });

  it('requires both hibernation state methods', () => {
    const invalid = translator(
      () =>
        ({
          inbound: (raw: string) => raw,
          hibernation: { serialize: () => ({}) },
        }) as never,
    );

    expect(() => invalid()).toThrow(/must provide both serialize\(\) and restore\(\)/);
  });
});
