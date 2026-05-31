import { describe, expect, it } from 'vitest';
import { contract } from './contract.ts';

describe('contract config validation', () => {
  it('rejects invalid keepalive config at contract creation', () => {
    expect(() =>
      contract('app', {
        keepalive: { pingIntervalMs: 0, idleTimeoutMs: 30_000 },
        definitions: [],
      }),
    ).toThrow(/keepalive\.pingIntervalMs/);
  });

  it('rejects keepalive whose ping interval is not less than the idle timeout', () => {
    expect(() =>
      contract('app', {
        keepalive: { pingIntervalMs: 30_000, idleTimeoutMs: 30_000 },
        definitions: [],
      }),
    ).toThrow(/must be less than/);
  });

  it('rejects invalid replay config at contract creation', () => {
    expect(() =>
      contract('app', {
        replay: { retention: { maxAgeMs: Number.POSITIVE_INFINITY } },
        definitions: [],
      }),
    ).toThrow(/retention\.maxAgeMs/);
  });

  it('rejects duplicate error codes at contract creation', () => {
    expect(() =>
      contract('app', {
        errors: [
          { code: 'duplicate', schema: undefined },
          { code: 'duplicate', schema: undefined },
        ],
        definitions: [],
      }),
    ).toThrow(/duplicate error code/);
  });
});
