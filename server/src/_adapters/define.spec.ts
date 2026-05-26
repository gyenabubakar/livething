import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { AsyncContextFactory, Logger, TimerProvider } from '~/context.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { defineServerAdapter } from './define.ts';
import type { EngineOptions } from './types.ts';

const noopHibernation = {
  persist: vi.fn(),
  restore: vi.fn(() => undefined),
};

type RuntimeOptions = Omit<EngineOptions, 'adapterId' | 'hibernation'>;

function makeAsyncContextFactory(): AsyncContextFactory {
  return function createAsyncContext<TStore>() {
    return {
      run<R>(_store: TStore, callback: () => R): R {
        return callback();
      },
      getStore(): TStore | undefined {
        return undefined;
      },
    };
  };
}

describe('defineServerAdapter', () => {
  function runtimeOptions(): RuntimeOptions {
    const timers: TimerProvider = {
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
      getAlarm: vi.fn(async () => null),
    };
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    return {
      env: { KEY: 'value' },
      platform: { kind: 'test' },
      timers,
      asyncContextFactory: makeAsyncContextFactory(),
      waitUntil: vi.fn(),
      logger,
    };
  }

  it('passes runtime-aware engine factory and options to setup', () => {
    const setup = vi.fn(() => ({ ok: true }));
    const serve = defineServerAdapter({ id: 'test', hibernation: noopHibernation, setup });

    const handler = { __wskit: 'server', primitives: [] } as unknown as ServerDefinition;
    const result = serve(handler, { port: 3000 });
    const [createEngine, options] = setup.mock.calls[0]! as unknown as [
      (runtimeOptions: RuntimeOptions) => Engine,
      { port: number },
    ];

    expect(result).toEqual({ ok: true });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(options).toEqual({ port: 3000 });
    expect(typeof createEngine).toBe('function');

    const engine = createEngine(runtimeOptions());
    expect(engine.core.options).toMatchObject({
      adapterId: 'test',
      hibernation: noopHibernation,
      env: { KEY: 'value' },
      platform: { kind: 'test' },
    });
  });

  it('passes the adapter hibernation API straight through to engine options', () => {
    let capturedFactory: ((runtimeOptions: RuntimeOptions) => Engine) | undefined;
    const api = { persist: vi.fn(), restore: vi.fn(() => ({ id: 'restored' })) };
    const serve = defineServerAdapter({
      id: 'cf',
      hibernation: api,
      setup(createEngine) {
        capturedFactory = createEngine;
        return {};
      },
    });

    serve({ __wskit: 'server', primitives: [] } as unknown as ServerDefinition, {} as never);
    expect(capturedFactory!(runtimeOptions()).core.options.hibernation).toBe(api);
  });

  it('omits hibernation in engine options when the adapter does not provide one', () => {
    let capturedFactory: ((runtimeOptions: RuntimeOptions) => Engine) | undefined;
    const serve = defineServerAdapter({
      id: 'no-hib',
      setup(createEngine) {
        capturedFactory = createEngine;
        return {};
      },
    });

    serve({ __wskit: 'server', primitives: [] } as unknown as ServerDefinition, {} as never);
    const engine = capturedFactory!(runtimeOptions());
    expect(engine.core.options.hibernation).toBe(undefined);
  });

  it('factory creates independent engine instances', () => {
    let capturedFactory: ((runtimeOptions: RuntimeOptions) => Engine) | undefined;
    const serve = defineServerAdapter({
      id: 'multi',
      setup(createEngine) {
        capturedFactory = createEngine;
        return {};
      },
    });

    serve({ __wskit: 'server', primitives: [] } as unknown as ServerDefinition, {} as never);
    const a = capturedFactory!(runtimeOptions());
    const b = capturedFactory!(runtimeOptions());
    expect(a).not.toBe(b);
  });
});
