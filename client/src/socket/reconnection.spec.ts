/* oxlint-disable @typescript-eslint/no-explicit-any -- testing with mock plugins */
import { Plugin } from '@/plugins/base.ts';
import { Reconnection } from '@/socket/reconnection.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Reconnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('shouldReconnect', () => {
    it('returns true by default', () => {
      const r = new Reconnection({}, []);
      expect(r.shouldReconnect(1006, '')).toBe(true);
    });

    it('returns false when reconnect option is false', () => {
      const r = new Reconnection({ reconnect: false }, []);
      expect(r.shouldReconnect(1006, '')).toBe(false);
    });

    it('checks plugin hooks first — false wins', () => {
      class NoReconnectPlugin extends Plugin {
        id = 'no-reconnect';
        override shouldReconnect() {
          return false as const;
        }
      }
      const plugin = new NoReconnectPlugin();
      const r = new Reconnection({}, [plugin]);
      expect(r.shouldReconnect(1006, '')).toBe(false);
    });

    it('checks plugin hooks first — true wins', () => {
      class ForceReconnectPlugin extends Plugin {
        id = 'force';
        override shouldReconnect() {
          return true as const;
        }
      }
      const plugin = new ForceReconnectPlugin();
      const r = new Reconnection({ nonRetryableCodes: [1006] }, [plugin]);
      // Plugin says true, overriding nonRetryableCodes
      expect(r.shouldReconnect(1006, '')).toBe(true);
    });

    it('first definitive plugin answer wins (array order)', () => {
      class AllowPlugin extends Plugin {
        id = 'allow';
        override shouldReconnect() {
          return true as const;
        }
      }
      class DenyPlugin extends Plugin {
        id = 'deny';
        override shouldReconnect() {
          return false as const;
        }
      }
      const r = new Reconnection({}, [new AllowPlugin(), new DenyPlugin()]);
      expect(r.shouldReconnect(1006, '')).toBe(true);
    });

    it('plugins returning void defer to next', () => {
      class DeferPlugin extends Plugin {
        id = 'defer';
        override shouldReconnect() {
          return undefined;
        }
      }
      const r = new Reconnection({ nonRetryableCodes: [4009] }, [new DeferPlugin()]);
      expect(r.shouldReconnect(4009, 'banned')).toBe(false);
      expect(r.shouldReconnect(1006, '')).toBe(true);
    });

    it('falls through to socket-level shouldReconnect callback', () => {
      const callback = vi.fn().mockReturnValue(false);
      const r = new Reconnection({ shouldReconnect: callback }, []);
      expect(r.shouldReconnect(4001, 'auth expired')).toBe(false);
      expect(callback).toHaveBeenCalledWith(4001, 'auth expired');
    });

    it('socket callback returning void falls through to nonRetryableCodes', () => {
      const callback = vi.fn().mockReturnValue(undefined);
      const r = new Reconnection(
        {
          shouldReconnect: callback,
          nonRetryableCodes: [4009],
        },
        [],
      );
      expect(r.shouldReconnect(4009, '')).toBe(false);
      expect(r.shouldReconnect(1006, '')).toBe(true);
    });

    it('checks nonRetryableCodes array', () => {
      const r = new Reconnection({ nonRetryableCodes: [4001, 4009] }, []);
      expect(r.shouldReconnect(4001, '')).toBe(false);
      expect(r.shouldReconnect(4009, '')).toBe(false);
      expect(r.shouldReconnect(1006, '')).toBe(true);
    });
  });

  describe('schedule', () => {
    it('calls onReconnect after backoff delay', () => {
      const r = new Reconnection({}, []);
      const onReconnect = vi.fn();
      const onExhausted = vi.fn();

      r.schedule(onReconnect, onExhausted);

      expect(onReconnect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1500); // first attempt ~1s ±30%
      expect(onReconnect).toHaveBeenCalledOnce();
      expect(onExhausted).not.toHaveBeenCalled();
    });

    it('increases delay with each attempt (exponential backoff)', () => {
      const r = new Reconnection({ maxReconnectDelay: 30_000 }, []);
      const delays: number[] = [];

      for (let i = 0; i < 5; i++) {
        const start = Date.now();
        r.schedule(() => {
          delays.push(Date.now() - start);
        }, vi.fn());
        vi.advanceTimersByTime(60_000); // advance well past any delay
      }

      // Each delay should roughly double (with jitter)
      // Attempt 0: ~1s, 1: ~2s, 2: ~4s, 3: ~8s, 4: ~16s
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]!).toBeGreaterThan(delays[i - 1]! * 0.9);
      }
    });

    it('caps delay at maxReconnectDelay', () => {
      const r = new Reconnection({ maxReconnectDelay: 5_000, maxReconnectAttempts: 20 }, []);

      // Burn through attempts to reach the cap
      for (let i = 0; i < 10; i++) {
        r.schedule(vi.fn(), vi.fn());
        vi.advanceTimersByTime(60_000);
      }

      // Next attempt should be capped at ~5s (±30% jitter)
      const onReconnect = vi.fn();
      r.schedule(onReconnect, vi.fn());

      vi.advanceTimersByTime(3_500); // 5000 * 0.7 = 3500 (min with jitter)
      // Should have fired by now or will fire shortly
      vi.advanceTimersByTime(3_500); // 5000 * 1.3 = 6500 (max with jitter)
      expect(onReconnect).toHaveBeenCalledOnce();
    });

    it('calls onExhausted when max attempts exceeded', () => {
      const r = new Reconnection({ maxReconnectAttempts: 2 }, []);
      const onExhausted = vi.fn();

      r.schedule(vi.fn(), onExhausted);
      vi.advanceTimersByTime(5_000);
      r.schedule(vi.fn(), onExhausted);
      vi.advanceTimersByTime(5_000);

      // Third attempt should be rejected
      const result = r.schedule(vi.fn(), onExhausted);
      expect(result).toBe(false);
      expect(onExhausted).toHaveBeenCalledOnce();
    });

    it('returns false when exhausted', () => {
      const r = new Reconnection({ maxReconnectAttempts: 0 }, []);
      expect(r.schedule(vi.fn(), vi.fn())).toBe(false);
    });

    it('does not schedule when paused', () => {
      const r = new Reconnection({}, []);
      const onReconnect = vi.fn();

      r.pause();
      r.schedule(onReconnect, vi.fn());

      vi.advanceTimersByTime(60_000);
      expect(onReconnect).not.toHaveBeenCalled();
    });
  });

  describe('reset', () => {
    it('resets attempt counter after successful connection', () => {
      const r = new Reconnection({ maxReconnectAttempts: 3 }, []);

      // Use up 2 attempts
      r.schedule(vi.fn(), vi.fn());
      vi.advanceTimersByTime(5_000);
      r.schedule(vi.fn(), vi.fn());
      vi.advanceTimersByTime(5_000);

      expect(r.currentAttempt).toBe(2);

      r.reset();
      expect(r.currentAttempt).toBe(0);

      // Should be able to schedule again
      const result = r.schedule(vi.fn(), vi.fn());
      expect(result).toBe(true);
    });
  });

  describe('stop', () => {
    it('cancels pending timer', () => {
      const r = new Reconnection({}, []);
      const onReconnect = vi.fn();

      r.schedule(onReconnect, vi.fn());
      r.stop();

      vi.advanceTimersByTime(60_000);
      expect(onReconnect).not.toHaveBeenCalled();
    });

    it('resets attempt counter', () => {
      const r = new Reconnection({}, []);
      r.schedule(vi.fn(), vi.fn());
      vi.advanceTimersByTime(5_000);

      r.stop();
      expect(r.currentAttempt).toBe(0);
    });
  });

  describe('pause / resume', () => {
    it('pause stops pending timer', () => {
      const r = new Reconnection({}, []);
      const onReconnect = vi.fn();

      r.schedule(onReconnect, vi.fn());
      r.pause();

      vi.advanceTimersByTime(60_000);
      expect(onReconnect).not.toHaveBeenCalled();
      expect(r.isPaused).toBe(true);
    });

    it('resume resets backoff and schedules immediately', () => {
      const r = new Reconnection({}, []);
      const onReconnect = vi.fn();

      r.pause();
      r.resume(onReconnect, vi.fn());

      expect(r.isPaused).toBe(false);

      // Should schedule with reset delay (~1s)
      vi.advanceTimersByTime(1_500);
      expect(onReconnect).toHaveBeenCalledOnce();
    });

    it('resume is no-op when not paused', () => {
      const r = new Reconnection({}, []);
      const onReconnect = vi.fn();

      r.resume(onReconnect, vi.fn());

      vi.advanceTimersByTime(60_000);
      expect(onReconnect).not.toHaveBeenCalled();
    });
  });

  describe('Infinity attempts', () => {
    it('never exhausts with maxReconnectAttempts: Infinity', () => {
      const r = new Reconnection({ maxReconnectAttempts: Infinity }, []);
      const onExhausted = vi.fn();

      for (let i = 0; i < 100; i++) {
        const result = r.schedule(vi.fn(), onExhausted);
        expect(result).toBe(true);
        vi.advanceTimersByTime(60_000);
      }

      expect(onExhausted).not.toHaveBeenCalled();
    });
  });
});
