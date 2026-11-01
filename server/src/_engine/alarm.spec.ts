import { createTestStorage } from '~/_test/sql.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  beginAlarmDelivery,
  endAlarmDelivery,
  ensureAlarmCoordinatorSchema,
  registerAlarmSource,
  rescheduleAlarm,
  restoreAlarmCoordinator,
} from './alarm.ts';

describe('framework alarm multiplexer', () => {
  it('arms one durable alarm at the earliest valid source deadline', () => {
    const setAlarm = vi.fn(async () => {});
    const deleteAlarm = vi.fn(async () => {});
    const core = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: { setAlarm, deleteAlarm },
    };

    registerAlarmSource(core, Symbol('later'), () => 500);
    registerAlarmSource(core, Symbol('earlier'), () => 200);
    registerAlarmSource(core, Symbol('none'), () => null);
    registerAlarmSource(core, Symbol('invalid'), () => Number.NaN);

    rescheduleAlarm(core);

    expect(setAlarm).toHaveBeenCalledWith(200);
    expect(deleteAlarm).not.toHaveBeenCalled();
  });

  it('clears the durable alarm when every source is empty', () => {
    const setAlarm = vi.fn(async () => {});
    const deleteAlarm = vi.fn(async () => {});
    const core = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: { setAlarm, deleteAlarm },
    };

    registerAlarmSource(core, Symbol('empty'), () => null);

    rescheduleAlarm(core);

    expect(setAlarm).not.toHaveBeenCalled();
    expect(deleteAlarm).toHaveBeenCalledTimes(1);
  });

  it('replaces a source idempotently instead of leaving duplicate deadlines', () => {
    const setAlarm = vi.fn(async () => {});
    const deleteAlarm = vi.fn(async () => {});
    const core = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: { setAlarm, deleteAlarm },
    };

    const key = Symbol('same-source');

    registerAlarmSource(core, key, () => 500);
    registerAlarmSource(core, key, () => 300);
    rescheduleAlarm(core);

    expect(core.alarmSources).toHaveLength(1);
    expect(setAlarm).toHaveBeenCalledWith(300);
  });

  it('keeps scheduling healthy sources when another source throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const setAlarm = vi.fn(async () => {});
    const error = vi.fn();
    const core = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: { setAlarm, deleteAlarm: vi.fn(async () => {}) },
      logger: { info: vi.fn(), warn: vi.fn(), error },
    };

    try {
      registerAlarmSource(core, Symbol('broken'), () => {
        throw new Error('source read failed');
      });
      registerAlarmSource(core, Symbol('healthy'), () => 1_500);

      await expect(rescheduleAlarm(core)).resolves.toBeUndefined();

      expect(setAlarm).toHaveBeenCalledWith(1_500);
      expect(error).toHaveBeenCalledWith('[livething] durable alarm source failed; retrying', {
        error: 'source read failed',
        sources: ['broken'],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes provider writes so an older async operation cannot overwrite a newer deadline', async () => {
    const pending: Array<{ time: number; resolve: () => void }> = [];
    const setAlarm = vi.fn(
      (time: number) =>
        new Promise<void>((resolve) => {
          pending.push({ time, resolve });
        }),
    );
    const core = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: { setAlarm, deleteAlarm: vi.fn(async () => {}) },
    };

    const key = Symbol('changing-source');
    let deadline: number | null = 100;

    registerAlarmSource(core, key, () => deadline);

    const first = rescheduleAlarm(core);
    deadline = 200;
    const second = rescheduleAlarm(core);

    expect(second).toBe(first);
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(pending[0]?.time).toBe(100);

    pending[0]!.resolve();
    await Promise.resolve();
    expect(setAlarm).toHaveBeenCalledTimes(2);
    expect(pending[1]?.time).toBe(200);

    pending[1]!.resolve();
    await first;
  });

  it('keeps a failed provider write retryable without an unhandled rejection', async () => {
    vi.useFakeTimers();
    let failures = 1;
    const setAlarm = vi.fn(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('temporary alarm failure');
      }
    });
    const error = vi.fn();
    const core = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: { setAlarm, deleteAlarm: vi.fn(async () => {}) },
      logger: { info: vi.fn(), warn: vi.fn(), error },
    };

    try {
      registerAlarmSource(core, Symbol('retryable-source'), () => 100);

      rescheduleAlarm(core);
      await Promise.resolve();
      await Promise.resolve();
      expect(error).toHaveBeenCalledWith('[livething] durable alarm reschedule failed', {
        error: 'temporary alarm failure',
      });

      rescheduleAlarm(core);
      await Promise.resolve();
      expect(setAlarm).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed provider write without waiting for another engine event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let failures = 1;
    const setAlarm = vi.fn(async () => {
      if (failures-- > 0) throw new Error('temporary alarm failure');
    });
    const core = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: { setAlarm, deleteAlarm: vi.fn(async () => {}) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    registerAlarmSource(core, Symbol('retryable-source'), () => 20_000);

    try {
      await expect(rescheduleAlarm(core)).rejects.toThrow('temporary alarm failure');
      expect(setAlarm).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(setAlarm).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries locally when storing a provider retry deadline fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const storage = createTestStorage();
    const setAlarm = vi.fn(async () => {
      throw new Error('timer provider unavailable');
    });
    const core = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: { setAlarm, deleteAlarm: vi.fn(async () => {}) },
      storage,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    ensureAlarmCoordinatorSchema(core);
    restoreAlarmCoordinator(core);
    storage.sql = {
      ...storage.sql,
      exec: vi.fn(() => {
        throw new Error('SQLite unavailable');
      }),
    };
    registerAlarmSource(core, Symbol('retryable-source'), () => 20_000);

    try {
      await expect(rescheduleAlarm(core)).rejects.toThrow('timer provider unavailable');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(setAlarm).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a provider write that failed while an alarm callback was active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let failures = 1;
    const setAlarm = vi.fn(async () => {
      if (failures-- > 0) throw new Error('temporary alarm failure');
    });
    const core = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: { setAlarm, deleteAlarm: vi.fn(async () => {}) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    registerAlarmSource(core, Symbol('retryable-source'), () => 20_000);

    try {
      beginAlarmDelivery(core);
      await expect(rescheduleAlarm(core)).rejects.toThrow('temporary alarm failure');
      endAlarmDelivery(core);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(setAlarm).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a durable wake-up after a provider write fails before restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const storage = createTestStorage();
    const failedCore = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: {
        setAlarm: vi.fn(async () => {
          throw new Error('provider unavailable');
        }),
        deleteAlarm: vi.fn(async () => {}),
      },
      storage,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    ensureAlarmCoordinatorSchema(failedCore);

    restoreAlarmCoordinator(failedCore);
    registerAlarmSource(failedCore, Symbol('scheduled work'), () => 200_000);

    try {
      await expect(rescheduleAlarm(failedCore)).rejects.toThrow('provider unavailable');

      const setAlarm = vi.fn(async () => {});
      const restartedCore = {
        alarmSources: new Map<symbol, () => number | null>(),
        timers: { setAlarm, deleteAlarm: vi.fn(async () => {}) },
        storage,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };

      ensureAlarmCoordinatorSchema(restartedCore);
      restoreAlarmCoordinator(restartedCore);

      await rescheduleAlarm(restartedCore);

      expect(setAlarm).toHaveBeenCalledWith(101_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restore a provider retry after that retry arms the real deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const storage = createTestStorage();
    let failures = 1;
    const firstSetAlarm = vi.fn(async () => {
      if (failures-- > 0) throw new Error('provider unavailable');
    });

    const firstCore = {
      alarmSources: new Map<symbol, () => number | null>(),
      timers: {
        setAlarm: firstSetAlarm,
        deleteAlarm: vi.fn(async () => {}),
      },
      storage,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    ensureAlarmCoordinatorSchema(firstCore);
    restoreAlarmCoordinator(firstCore);
    registerAlarmSource(firstCore, Symbol('scheduled work'), () => 200_000);

    try {
      await expect(rescheduleAlarm(firstCore)).rejects.toThrow('provider unavailable');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(firstSetAlarm).toHaveBeenLastCalledWith(200_000);

      const restartedSetAlarm = vi.fn(async () => {});
      const restartedCore = {
        alarmSources: new Map<symbol, () => number | null>(),
        timers: {
          setAlarm: restartedSetAlarm,
          deleteAlarm: vi.fn(async () => {}),
        },
        storage,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };

      ensureAlarmCoordinatorSchema(restartedCore);
      restoreAlarmCoordinator(restartedCore);
      registerAlarmSource(restartedCore, Symbol('scheduled work'), () => 200_000);

      await rescheduleAlarm(restartedCore);

      expect(restartedSetAlarm).toHaveBeenLastCalledWith(200_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['setAlarm', 100],
    ['deleteAlarm', null],
  ] as const)(
    'returns a rejected Promise for a failed %s write and retries it without another event',
    async (method, deadline) => {
      vi.useFakeTimers();
      let failures = 1;
      const setAlarm = vi.fn(async () => {
        if (method === 'setAlarm' && failures-- > 0) throw new Error('set failed');
      });
      const deleteAlarm = vi.fn(async () => {
        if (method === 'deleteAlarm' && failures-- > 0) throw new Error('delete failed');
      });
      const error = vi.fn();

      const core = {
        alarmSources: new Map<symbol, () => number | null>(),
        timers: { setAlarm, deleteAlarm },
        logger: { info: vi.fn(), warn: vi.fn(), error },
      };

      try {
        registerAlarmSource(core, Symbol('source'), () => deadline);

        await expect(rescheduleAlarm(core)).rejects.toThrow(
          `${method === 'setAlarm' ? 'set' : 'delete'} failed`,
        );
        await vi.advanceTimersByTimeAsync(1_000);

        expect(method === 'setAlarm' ? setAlarm : deleteAlarm).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
