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

  it('handles a promise that rejects later, so Node does not report an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    function record(reason: unknown) {
      unhandled.push(reason);
    }

    process.on('unhandledRejection', record);

    try {
      let reject!: (error: Error) => void;
      const pending = new Promise((_resolve, rejectPending) => (reject = rejectPending));

      expect(() => rejectAsyncTransactionResult(pending)).toThrow(/callbacks must be synchronous/);
      reject(new Error('write failed'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('does not call then on a thenable that is not a promise, so a query builder never runs', () => {
    let ran = false;
    const queryBuilder = {
      then() {
        ran = true;
      },
    };

    // One that claims to be a Promise through Symbol.toStringTag must not run either.
    const taggedBuilder = {
      [Symbol.toStringTag]: 'Promise',
      then() {
        ran = true;
      },
    };

    for (const builder of [queryBuilder, taggedBuilder]) {
      expect(() => rejectAsyncTransactionResult(builder)).toThrow(/callbacks must be synchronous/);
    }

    expect(ran).toBe(false);
  });

  it('accepts plain values and objects whose then is not a function', () => {
    for (const value of [undefined, null, 0, 'text', { id: 1 }, { then: 5 }, () => 1]) {
      expect(() => rejectAsyncTransactionResult(value)).not.toThrow();
    }
  });
});
