import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import { scheduled } from './capability.ts';

function makeBase() {
  return define({
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

  it('returns nothing after registering a task body', () => {
    const base = makeBase();
    const result = base.scheduled('heartbeat', { run() {} });
    expectTypeOf(result).toEqualTypeOf<void>();
  });
});
