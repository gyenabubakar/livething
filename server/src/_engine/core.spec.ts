import { define } from '~/_define/define.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { describe, expect, it } from 'vitest';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import { EngineCore } from './core.ts';

const handler = define({}).assemble({ handlers: [] });

function validOptions(): EngineAdapterTypes.EngineOptions {
  return {
    adapterId: 'test-adapter',
    storage: { sql: createTestSql(), kv: createTestKV() },

    platform: {},
    timers: createTestTimers(),
    asyncContextFactory: <TStore>() => {
      let current: TStore | undefined;
      return {
        run<R>(store: TStore, callback: () => R): R {
          const prev = current;
          current = store;
          try {
            return callback();
          } finally {
            current = prev;
          }
        },
        getStore: () => current,
      };
    },
    logger: { info() {}, warn() {}, error() {} },
  };
}

describe('EngineCore constructor — adapter option guards', () => {
  it('builds cleanly when every required option is provided', () => {
    expect(() => new EngineCore(handler, validOptions())).not.toThrow();
  });

  it('throws naming the adapter when storage is missing', () => {
    const options = validOptions();
    options.storage = undefined as never;
    expect(() => new EngineCore(handler, options)).toThrow(
      '[wskit] Adapter "test-adapter" did not provide storage.',
    );
  });

  it('throws naming the adapter when timers is missing', () => {
    const options = validOptions();
    options.timers = undefined as never;
    expect(() => new EngineCore(handler, options)).toThrow(
      '[wskit] Adapter "test-adapter" did not provide timers.',
    );
  });
});
