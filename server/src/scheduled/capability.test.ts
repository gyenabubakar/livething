import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import { scheduled } from './capability.ts';

function makeBase() {
  return server({
    capabilities: [
      scheduled({
        cleanup: null,
        heartbeat: { every: 30_000 },
        report: { data: t<{ userId: string }>(), retry: true },
      }),
    ],
  });
}

describe('scheduled() typing', () => {
  it('passes the declared payload type to a task body', () => {
    const base = makeBase();
    base.scheduled('report', {
      run(_ctx, data) {
        expectTypeOf(data).toEqualTypeOf<{ userId: string }>();
      },
    });
  });

  it('gives a no-data task body no data argument', () => {
    const base = makeBase();
    base.scheduled('cleanup', {
      run(ctx) {
        expectTypeOf(ctx.broadcast).toBeFunction();
      },
    });
  });

  it('rejects binding an undeclared task', () => {
    const base = makeBase();
    // @ts-expect-error 'nope' was not declared in scheduled({ ... })
    base.scheduled('nope', { run() {} });
  });

  it('requires data when scheduling a task that declares it', () => {
    const base = makeBase();
    base.on('go', {
      input: v.object({}),
      run(ctx) {
        ctx.schedule('report', { time: 1, data: { userId: 'a' } });
        // @ts-expect-error 'report' requires a data field
        ctx.schedule('report', { time: 1 });
      },
    });
  });

  it('rejects a recurring task that also declares data', () => {
    // @ts-expect-error a task with `every` cannot declare `data`
    scheduled({ heartbeat: { every: 1_000, data: t<{ n: number }>() } });
    // @ts-expect-error a task with `every` cannot declare `data`, even with retry
    scheduled({ heartbeat: { every: 1_000, data: t<{ n: number }>(), retry: true } });
    // @ts-expect-error a schema validator counts as data too
    scheduled({ heartbeat: { every: 1_000, data: v.object({}) } });
    scheduled({ heartbeat: { every: 1_000, retry: [1_000] } });
  });

  it('returns a handler that assemble() accepts', () => {
    const base = makeBase();
    const result = base.scheduled('heartbeat', { run() {} });
    expectTypeOf(result).not.toBeVoid();
    base.assemble({
      handlers: [
        result,
        base.scheduled('cleanup', { run() {} }),
        base.scheduled('report', { run() {} }),
      ],
    });
  });
});
