import { describe, expect, it } from 'vitest';
import { contract } from './contract.ts';

describe('contract config validation', () => {
  it('rejects invalid heartbeat config at contract creation', () => {
    expect(() =>
      contract('app', {
        heartbeat: { timeoutMs: 0 },
        definitions: [],
      }),
    ).toThrow(/heartbeat\.timeoutMs/);
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
