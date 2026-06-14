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
    const handler = base.assemble(handleCleanup);
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
    const primitive = scheduledPrimitive(base.assemble(handleReport).primitives);
    expect(primitive.hasData).toBe(true);
    expect(primitive.options?.retry).toBe(true);
  });

  it('carries the recurring interval onto the task primitive', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [scheduled({ heartbeat: { every: 30_000 } })],
    });
    const handleHeartbeat = base.scheduled('heartbeat', { run() {} });
    const primitive = scheduledPrimitive(base.assemble(handleHeartbeat).primitives);
    expect(primitive.options?.every).toBe(30_000);
  });

  it('throws when a declared task has no handler', () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    expect(() => base.assemble()).toThrow(/No handler for scheduled task 'cleanup'/);
  });

  it('throws when a handler has no matching declaration', () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    const cleanup = base.scheduled('cleanup', { run() {} });
    const otherBase = define({ env: t<Env>(), capabilities: [scheduled({ other: null })] });
    const orphan = otherBase.scheduled('other', { run() {} });
    expect(() => base.assemble(cleanup, orphan)).toThrow(
      /base\.scheduled\('other'\) has no matching declaration/,
    );
  });

  it('throws when the same task is bound twice', () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    const first = base.scheduled('cleanup', { run() {} });
    const second = base.scheduled('cleanup', { run() {} });
    expect(() => base.assemble(first, second)).toThrow(/Duplicate scheduled handler for 'cleanup'/);
  });

  it('passes trusted data to the merged handler at runtime', async () => {
    const base = define({
      env: t<Env>(),
      capabilities: [scheduled({ report: { data: t<{ userId: string }>() } })],
    });
    const run = vi.fn();
    const handleReport = base.scheduled('report', { run });
    const primitive = scheduledPrimitive(base.assemble(handleReport).primitives);

    const ctx = {} as never;
    await primitive.handler(ctx, { userId: 'alice' });
    expect(run).toHaveBeenCalledWith(ctx, { userId: 'alice' });
  });

  it('runs a no-data task body with only the context', async () => {
    const base = define({ env: t<Env>(), capabilities: [scheduled({ cleanup: null })] });
    const run = vi.fn();
    const handleCleanup = base.scheduled('cleanup', { run });
    const primitive = scheduledPrimitive(base.assemble(handleCleanup).primitives);

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
    expect(() => base.assemble(orphan as never)).toThrow(
      /base\.scheduled\('cleanup'\) has no matching declaration/,
    );
  });
});
