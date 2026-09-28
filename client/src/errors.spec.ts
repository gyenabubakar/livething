import { Block, Disconnected, error, LiveThingError, Timeout, ValidationFailed } from '~/errors.ts';
import { describe, expect, it } from 'vitest';

describe('errors subpath', () => {
  it('re-exports the runtime error toolkit from core', () => {
    expect(typeof error).toBe('function');
    expect(typeof LiveThingError).toBe('function');
    expect(Block).toBeDefined();
    expect(ValidationFailed).toBeDefined();
  });

  it('built-in error definitions narrow with matches()', () => {
    expect(Timeout.matches(new LiveThingError('timeout', undefined))).toBe(true);
    expect(Disconnected.matches(new LiveThingError('disconnected', undefined))).toBe(true);
    expect(Timeout.matches(new LiveThingError('disconnected', undefined))).toBe(false);
  });
});
