import { describe, expect, it } from 'vitest';
import { assertSynchronousResult, WSKitConfigError } from './sync-guard.ts';

describe('assertSynchronousResult', () => {
  it('returns a synchronous result for validator and callback uses', () => {
    expect(assertSynchronousResult(3, 'value', 'validator')).toBe(3);
    expect(assertSynchronousResult('ok', 'value', 'callback')).toBe('ok');
  });

  it('rejects thenables with the validator-specific message', () => {
    expect(() =>
      assertSynchronousResult(Promise.resolve(true), 'user schema', 'validator'),
    ).toThrow(
      new WSKitConfigError(
        '[wskit] async validators are not supported (user schema). Use a sync schema or parse function.',
      ),
    );
  });

  it('rejects thenables with the callback-specific message', () => {
    expect(() =>
      assertSynchronousResult(Promise.resolve(true), 'adapter callback', 'callback'),
    ).toThrow(
      new WSKitConfigError(
        '[wskit] async callbacks are not supported (adapter callback). Use a synchronous callback.',
      ),
    );
  });
});
