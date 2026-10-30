import { LiveThingConfigError } from '@livething/core';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { scheduled } from './capability.ts';
import type { ScheduledPrimitive } from './scheduled.ts';

type AnyScheduledPrimitive = Omit<ScheduledPrimitive, 'handler'> & {
  handler: (ctx: unknown, data?: unknown) => void | Promise<void>;
};

function scheduledPrimitive(primitives: readonly { __livething: string }[]): AnyScheduledPrimitive {
  const found = primitives.find((p) => p.__livething === 'scheduled');
  if (!found) throw new Error('no scheduled primitive');

  return found as unknown as AnyScheduledPrimitive;
}

describe('scheduled() capability', () => {
  it('registers a declaration body into one bootable task', () => {
    const base = server({ capabilities: [scheduled({ cleanup: null })] });
    const cleanup = base.scheduled('cleanup', { run() {} });
    const definition = base.assemble({ handlers: [cleanup] });
    const compiled = compileServerDefinition(definition);
    expect(compiled.scheduled.has('cleanup')).toBe(true);

    expect(scheduledPrimitive(definition.primitives).hasData).toBe(false);
  });

  it('marks a task that declares typed data as carrying data', () => {
    const base = server({
      capabilities: [scheduled({ report: { data: t<{ userId: string }>(), retry: true } })],
    });
    const report = base.scheduled('report', { run() {} });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [report] }).primitives);
    expect(primitive.hasData).toBe(true);
    expect(primitive.options?.retry).toBe(true);
  });

  it('carries the recurring interval onto the task primitive', () => {
    const base = server({
      capabilities: [scheduled({ heartbeat: { every: 30_000 } })],
    });
    const heartbeat = base.scheduled('heartbeat', { run() {} });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [heartbeat] }).primitives);
    expect(primitive.options?.every).toBe(30_000);
  });

  it('throws when a task id contains ::', () => {
    expect(() => scheduled({ 'cleanup::daily': null })).toThrow(
      /scheduled\(\) task id 'cleanup::daily' contains '::'/,
    );
  });

  it('throws when a declared task has no body', () => {
    const base = server({ capabilities: [scheduled({ cleanup: null })] });
    base.scheduled('cleanup', { run() {} });
    const noHandlers: never[] = [];
    expect(() => base.assemble({ handlers: noHandlers })).toThrow(
      /Pass base\.scheduled\('cleanup', \.\.\.\) to assemble\(\)/,
    );
  });

  it('throws when the same task is passed twice', () => {
    const base = server({ capabilities: [scheduled({ cleanup: null })] });
    const handlers = [
      base.scheduled('cleanup', { run() {} }),
      base.scheduled('cleanup', { run() {} }),
    ];
    expect(() => base.assemble({ handlers })).toThrow(/Duplicate scheduled task 'cleanup'/);
  });

  it('passes trusted data to the registered body at runtime', async () => {
    const base = server({
      capabilities: [scheduled({ report: { data: t<{ userId: string }>() } })],
    });
    const run = vi.fn();
    const report = base.scheduled('report', { run });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [report] }).primitives);

    const ctx = {} as never;
    await primitive.handler(ctx, { userId: 'alice' });
    expect(run).toHaveBeenCalledWith(ctx, { userId: 'alice' });
  });

  it('runs a no-data task body with only the context', async () => {
    const base = server({ capabilities: [scheduled({ cleanup: null })] });
    const run = vi.fn();
    const cleanup = base.scheduled('cleanup', { run });
    const primitive = scheduledPrimitive(base.assemble({ handlers: [cleanup] }).primitives);

    const ctx = {} as never;
    await primitive.handler(ctx);
    expect(run).toHaveBeenCalledWith(ctx);
  });

  it('throws when a scheduled body has no matching declaration', () => {
    const base = server({});
    const escapeHatch = base as unknown as {
      scheduled(taskId: string, config: { run: () => void }): unknown;
      assemble(config: { handlers: unknown[] }): unknown;
    };
    const stray = escapeHatch.scheduled('cleanup', { run() {} });
    expect(() => escapeHatch.assemble({ handlers: [stray] })).toThrow(
      /'cleanup'.*no matching declaration/,
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

    it('rejects every combined with a t<...>() data marker', () => {
      function declareBoth() {
        return scheduled({ heartbeat: { every: 1_000, data: t<{ n: number }>() } as never });
      }

      expect(declareBoth).toThrow(LiveThingConfigError);
      expect(declareBoth).toThrow(
        /scheduled\("heartbeat"\): a task with 'every' cannot declare 'data'/,
      );
    });

    it('rejects every combined with a schema data validator', () => {
      expect(() => scheduled({ heartbeat: { every: 1_000, data: v.object({}) } as never })).toThrow(
        /cannot declare 'data'/,
      );
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
