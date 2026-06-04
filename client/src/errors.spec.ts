import { Block, Disconnected, error, Timeout, ValidationFailed, WSKitError } from '~/errors.ts';
import { describe, expect, it } from 'vitest';

describe('errors subpath', () => {
  it('re-exports the runtime error toolkit from core', () => {
    expect(typeof error).toBe('function');
    expect(typeof WSKitError).toBe('function');
    expect(Block).toBeDefined();
    expect(ValidationFailed).toBeDefined();
  });

  it('built-in error definitions narrow with matches()', () => {
    expect(Timeout.matches(new WSKitError('timeout', undefined))).toBe(true);
    expect(Disconnected.matches(new WSKitError('disconnected', undefined))).toBe(true);
    expect(Timeout.matches(new WSKitError('disconnected', undefined))).toBe(false);
  });
});
