import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { describe, expect, it, vi } from 'vitest';
import { scheduled } from './capability.ts';
import type { ScheduledPrimitive } from './scheduled.ts';

interface Env {
  SECRET: string;
}

type AnyScheduledPrimitive = Omit<ScheduledPrimitive, 'handler'> & {
  handler: (ctx: unknown, data?: unknown) => void | Promise<void>;
};

function scheduledPrimitive(primitives: readonly { __wskit: string }[]): AnyScheduledPrimitive {
  const found = primitives.find((p) => p.__wskit === 'scheduled');
  if (!found) throw new Error('no scheduled primitive');
  return found as unknown as AnyScheduledPrimitive;
}

describe('scheduled() capability', () => {
  it('registers a declaration body into one bootable task', () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    base.scheduled('cleanup', { run() {} });
    const handler = base.assemble({ handlers: [] });
    const compiled = compileHandlerDefinition(handler);
    expect(compiled.scheduled.has('cleanup')).toBe(true);
    expect(scheduledPrimitive(handler.primitives).hasData).toBe(false);
  });

  it('marks a task that declares typed data as carrying data', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [scheduled({ report: { data: t<{ userId: string }>(), retry: true } })],
    });
    base.scheduled('report', { run() {} });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [] }).primitives);
    expect(primitive.hasData).toBe(true);
    expect(primitive.options?.retry).toBe(true);
  });

  it('carries the recurring interval onto the task primitive', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [scheduled({ heartbeat: { every: 30_000 } })],
    });
    base.scheduled('heartbeat', { run() {} });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [] }).primitives);
    expect(primitive.options?.every).toBe(30_000);
  });

  it('throws when a declared task has no body', () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    expect(() => base.assemble({ handlers: [] })).toThrow(/No body for scheduled task 'cleanup'/);
  });

  it('throws when the same task is registered twice', () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    base.scheduled('cleanup', { run() {} });
    expect(() => base.scheduled('cleanup', { run() {} })).toThrow(
      /Duplicate scheduled task 'cleanup'/,
    );
  });

  it('passes trusted data to the registered body at runtime', async () => {
    const base = define({
      env: t<Env>(),
      capabilities: [scheduled({ report: { data: t<{ userId: string }>() } })],
    });
    const run = vi.fn();
    base.scheduled('report', { run });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [] }).primitives);

    const ctx = {} as never;
    await primitive.handler(ctx, { userId: 'alice' });
    expect(run).toHaveBeenCalledWith(ctx, { userId: 'alice' });
  });

  it('runs a no-data task body with only the context', async () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    const run = vi.fn();
    base.scheduled('cleanup', { run });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [] }).primitives);

    const ctx = {} as never;
    await primitive.handler(ctx);
    expect(run).toHaveBeenCalledWith(ctx);
  });

  it('throws when a scheduled body has no matching declaration', () => {
    const base = define({ env: t<Env>() });
    const escapeHatch = base as unknown as {
      scheduled(taskId: string, config: { run: () => void }): unknown;
    };
    escapeHatch.scheduled('cleanup', { run() {} });
    expect(() => base.assemble({ handlers: [] })).toThrow(
      /base\.scheduled\('cleanup'\) has no matching declaration/,
    );
  });

  describe('every validation', () => {
    function declare(every: number) {
      return () => scheduled({ heartbeat: { every } });
    }

    it('rejects NaN', () => {
      expect(declare(Number.NaN)).toThrow(/positive safe integer/);
    });

    it('rejects zero', () => {
      expect(declare(0)).toThrow(/positive safe integer/);
    });

    it('rejects negative numbers', () => {
      expect(declare(-1000)).toThrow(/positive safe integer/);
    });

    it('rejects fractional numbers', () => {
      expect(declare(1.5)).toThrow(/positive safe integer/);
    });

    it('rejects Infinity', () => {
      expect(declare(Number.POSITIVE_INFINITY)).toThrow(/positive safe integer/);
    });

    it('names the task in the message', () => {
      expect(declare(0)).toThrow(/scheduled\("heartbeat"\)/);
    });

    it('accepts positive integers', () => {
      expect(declare(1)).not.toThrow();
      expect(declare(30_000)).not.toThrow();
    });
  });

  describe('retry array validation', () => {
    function declare(retry: readonly number[]) {
      return () => scheduled({ report: { data: t<{ userId: string }>(), retry } });
    }

    it('rejects an empty array', () => {
      expect(declare([])).toThrow(/at least one entry/);
    });

    it('rejects zero entries', () => {
      expect(declare([0])).toThrow(/positive safe integer/);
      expect(declare([100, 0, 200])).toThrow(/positive safe integer/);
    });

    it('rejects negative entries', () => {
      expect(declare([-5])).toThrow(/positive safe integer/);
    });

    it('rejects NaN entries', () => {
      expect(declare([Number.NaN])).toThrow(/positive safe integer/);
    });

    it('rejects fractional entries', () => {
      expect(declare([1.5])).toThrow(/positive safe integer/);
    });

    it('names the task in the message', () => {
      expect(declare([])).toThrow(/scheduled\("report"\)/);
    });

    it('accepts a non-empty array of positive integers', () => {
      expect(declare([100])).not.toThrow();
      expect(declare([50, 100, 200, 1_000])).not.toThrow();
    });

    it('still accepts boolean retry values', () => {
      expect(() =>
        scheduled({ report: { data: t<{ userId: string }>(), retry: true } }),
      ).not.toThrow();
      expect(() =>
        scheduled({ report: { data: t<{ userId: string }>(), retry: false } }),
      ).not.toThrow();
    });
  });
});
