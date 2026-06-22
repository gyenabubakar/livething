import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import { scheduled } from './capability.ts';

const base = define({
  env: t<{ SECRET: string }>(),
  capabilities: [
    scheduled({
      cleanup: null,
      heartbeat: { every: 30_000 },
      report: { data: t<{ userId: string }>(), retry: true },
    }),
  ],
});

describe('scheduled() typing', () => {
  it('passes the declared payload type to a task body', () => {
    base.scheduled('report', {
      run(_ctx, data) {
        expectTypeOf(data).toEqualTypeOf<{ userId: string }>();
      },
    });
  });

  it('gives a no-data task body no data argument', () => {
    base.scheduled('cleanup', {
      run(ctx) {
        expectTypeOf(ctx.broadcast).toBeFunction();
      },
    });
  });

  it('rejects binding an undeclared task', () => {
    // @ts-expect-error 'nope' was not declared in scheduled({ ... })
    base.scheduled('nope', { run() {} });
  });

  it('requires data when scheduling a task that declares it', () => {
    base.on('go', {
      input: v.object({}),
      run(ctx) {
        ctx.schedule('report', { time: 1, data: { userId: 'a' } });
        // @ts-expect-error 'report' requires a data field
        ctx.schedule('report', { time: 1 });
      },
    });
  });
});
