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
  it('merges a declaration with its handler into one bootable task', () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    const handleCleanup = base.scheduled('cleanup', { run() {} });
    const handler = base.assemble({ handlers: [handleCleanup] });
    const compiled = compileHandlerDefinition(handler);
    expect(compiled.scheduled.has('cleanup')).toBe(true);
    expect(scheduledPrimitive(handler.primitives).hasData).toBe(false);
  });

  it('marks a task that declares typed data as carrying data', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [scheduled({ report: { data: t<{ userId: string }>(), retry: true } })],
    });
    const handleReport = base.scheduled('report', { run() {} });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [handleReport] }).primitives);
    expect(primitive.hasData).toBe(true);
    expect(primitive.options?.retry).toBe(true);
  });

  it('carries the recurring interval onto the task primitive', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [scheduled({ heartbeat: { every: 30_000 } })],
    });
    const handleHeartbeat = base.scheduled('heartbeat', { run() {} });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [handleHeartbeat] }).primitives);
    expect(primitive.options?.every).toBe(30_000);
  });

  it('throws when a declared task has no handler', () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    expect(() => base.assemble({ handlers: [] })).toThrow(
      /No handler for scheduled task 'cleanup'/,
    );
  });

  it('throws when a handler has no matching declaration', () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    const cleanup = base.scheduled('cleanup', { run() {} });
    const otherBase = define({ env: t<Env>(), capabilities: [scheduled({ other: null })] });
    const orphan = otherBase.scheduled('other', { run() {} });
    expect(() => base.assemble({ handlers: [cleanup, orphan] })).toThrow(
      /base\.scheduled\('other'\) has no matching declaration/,
    );
  });

  it('throws when the same task is bound twice', () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    const first = base.scheduled('cleanup', { run() {} });
    const second = base.scheduled('cleanup', { run() {} });
    expect(() => base.assemble({ handlers: [first, second] })).toThrow(
      /Duplicate scheduled handler for 'cleanup'/,
    );
  });

  it('passes trusted data to the merged handler at runtime', async () => {
    const base = define({
      env: t<Env>(),
      capabilities: [scheduled({ report: { data: t<{ userId: string }>() } })],
    });
    const run = vi.fn();
    const handleReport = base.scheduled('report', { run });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [handleReport] }).primitives);

    const ctx = {} as never;
    await primitive.handler(ctx, { userId: 'alice' });
    expect(run).toHaveBeenCalledWith(ctx, { userId: 'alice' });
  });

  it('runs a no-data task body with only the context', async () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    const run = vi.fn();
    const handleCleanup = base.scheduled('cleanup', { run });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [handleCleanup] }).primitives);

    const ctx = {} as never;
    await primitive.handler(ctx);
    expect(run).toHaveBeenCalledWith(ctx);
  });

  it('throws when a scheduled body is assembled without the scheduled() capability', () => {
    const base = define({ env: t<Env>() });
    const escapeHatch = base as unknown as {
      scheduled(taskId: string, config: { run: () => void }): unknown;
    };
    const orphan = escapeHatch.scheduled('cleanup', { run() {} });
    expect(() => base.assemble({ handlers: [orphan as never] })).toThrow(
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
