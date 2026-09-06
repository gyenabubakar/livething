import { define } from '~/_define/define.ts';
import { registerAlarmSource, rescheduleAlarm } from '~/_engine/alarm.ts';
import { Engine } from '~/_engine/engine.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsyncContextFactory, TimerProvider } from '~/context.ts';

function passthroughAsyncContext(): AsyncContextFactory {
  return function createAsyncContext<TStore>() {
    let current: TStore | undefined;
    return {
      run<R>(store: TStore, callback: () => R): R {
        const previous = current;
        current = store;
        try {
          return callback();
        } finally {
          current = previous;
        }
      },
      getStore: () => current,
    };
  };
}

function buildEngine(timers: TimerProvider): Engine {
  const base = define({});
  const handler = base.assemble({ handlers: [] });
  return new Engine(handler, {
    adapterId: 'test',
    storage: createTestStorage(),

    platform: {},
    timers,
    logger: { info() {}, warn() {}, error() {} },
    asyncContextFactory: passthroughAsyncContext(),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('engine shutdown', () => {
  it('does not retry a failed alarm write after shutdown starts', async () => {
    vi.useFakeTimers();
    const setAlarm = vi.fn(async () => {
      throw new Error('adapter storage is unavailable');
    });
    const engine = buildEngine({
      setAlarm,
      deleteAlarm: vi.fn(async () => {}),
      getAlarm: vi.fn(async () => null),
    });
    registerAlarmSource(engine.core, Symbol('test alarm'), () => 20_000);

    await expect(rescheduleAlarm(engine.core)).rejects.toThrow('adapter storage is unavailable');
    await engine.handleShutdown({ terminal: true });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(setAlarm).toHaveBeenCalledOnce();
  });

  it('keeps alarm retries running after a non-terminal drain', async () => {
    vi.useFakeTimers();
    let failures = 1;
    const setAlarm = vi.fn(async () => {
      if (failures-- > 0) throw new Error('temporary adapter failure');
    });
    const engine = buildEngine({
      setAlarm,
      deleteAlarm: vi.fn(async () => {}),
      getAlarm: vi.fn(async () => null),
    });
    registerAlarmSource(engine.core, Symbol('test alarm'), () => 20_000);

    await expect(rescheduleAlarm(engine.core)).rejects.toThrow('temporary adapter failure');
    await engine.handleShutdown();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(setAlarm).toHaveBeenCalledTimes(2);
  });

  it('does not make a non-terminal drain wait for best-effort after-send work', async () => {
    const engine = buildEngine({
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
      getAlarm: vi.fn(async () => null),
    });
    let finish!: () => void;
    const pendingAfterSend = new Promise<void>((resolve) => {
      finish = resolve;
    });
    engine.core.trackBackgroundWork(pendingAfterSend);
    let shutdownFinished = false;
    const shutdown = engine.handleShutdown().then(() => {
      shutdownFinished = true;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(shutdownFinished).toBe(true);
    } finally {
      finish();
      await shutdown;
    }
  });

  it('waits for engine-owned background work before shutdown finishes', async () => {
    const engine = buildEngine({
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
      getAlarm: vi.fn(async () => null),
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    engine.core.trackBackgroundWork(pending);
    let shutdownHookFinished = false;
    engine.core.hooks.shutdown.push(() => {
      shutdownHookFinished = true;
    });

    let shutdownFinished = false;
    const shutdown = engine.handleShutdown({ terminal: true }).then(() => {
      shutdownFinished = true;
    });

    await vi.waitFor(() => expect(shutdownHookFinished).toBe(true));
    expect(shutdownFinished).toBe(false);

    finish();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });
});
