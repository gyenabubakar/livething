import { describe, expect, it } from 'vitest';
import {
  rejectAsyncTransactionCallback,
  rejectAsyncTransactionResult,
} from './sync-transaction.ts';

describe('rejectAsyncTransactionCallback', () => {
  it('throws for an async function and for an async arrow function', () => {
    expect(() => rejectAsyncTransactionCallback(async function work() {})).toThrow(
      /callbacks must be synchronous/,
    );
    expect(() => rejectAsyncTransactionCallback(async () => {})).toThrow(
      /callbacks must be synchronous/,
    );
  });

  it('accepts a plain function and a function that returns a promise', () => {
    expect(() => rejectAsyncTransactionCallback(() => 1)).not.toThrow();
    expect(() => rejectAsyncTransactionCallback(() => Promise.resolve(1))).not.toThrow();
  });
});

describe('rejectAsyncTransactionResult', () => {
  it('throws for a promise, a plain object with then, and a function with then', () => {
    const callableThenable = Object.assign(() => {}, { then() {} });

    expect(() => rejectAsyncTransactionResult(Promise.resolve(1))).toThrow(
      /callbacks must be synchronous/,
    );
    expect(() => rejectAsyncTransactionResult({ then() {} })).toThrow(
      /callbacks must be synchronous/,
    );
    expect(() => rejectAsyncTransactionResult(callableThenable)).toThrow(
      /callbacks must be synchronous/,
    );
  });

  it('accepts plain values and objects whose then is not a function', () => {
    for (const value of [undefined, null, 0, 'text', { id: 1 }, { then: 5 }, () => 1]) {
      expect(() => rejectAsyncTransactionResult(value)).not.toThrow();
    }
  });
});
