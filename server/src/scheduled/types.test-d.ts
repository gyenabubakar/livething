/**
 * Compile-time fixture: scheduled task API type-safety.
 *
 * This file must compile with zero errors. @ts-expect-error directives assert
 * that invalid scheduled-task declarations and enqueue calls are rejected.
 */

import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { withScheduled } from '~/scheduled/with.ts';
import * as v from 'valibot';

const trigger = event('trigger', (p: unknown) => p as {});

withScheduled(server('app'))
  .scheduled('cleanup', (t) =>
    t.retry(false).run((ctx) => {
      const rows = ctx.sql.exec<{ id: string }>('SELECT id FROM users').toArray();
      const row = ctx.sql.exec<{ id: string }>('SELECT id FROM users LIMIT 1').one();
      const unknownRows = ctx.sql.exec('SELECT id FROM users').toArray();

      if (rows[0]) void (rows[0].id satisfies string);
      if (row) void (row.id satisfies string);
      ctx.sql.transaction((tx) => {
        const txRow = tx.exec<{ id: number }>('SELECT id FROM users LIMIT 1').one();
        if (txRow) void (txRow.id satisfies number);
      });

      // @ts-expect-error — SQL rows default to unknown until a row type is provided
      unknownRows[0].id;
    }),
  )
  .incoming(trigger, (ctx) => {
    ctx.schedule('cleanup', { time: Date.now() + 100 });

    // @ts-expect-error — no-data tasks do not accept schedule-time data
    ctx.schedule('cleanup', { time: Date.now() + 100, data: { nope: true } });
  });

withScheduled(server('app'))
  .scheduled('send-to-conn', (t) =>
    t
      .data(v.object({ connectionId: v.string(), text: v.string() }))
      .retry([50, 100])
      .run((ctx, data) => {
        void ctx.sql;
        void (data.connectionId satisfies string);
        void (data.text satisfies string);
      }),
  )
  .incoming(trigger, (ctx) => {
    ctx.schedule('send-to-conn', {
      time: Date.now() + 100,
      data: { connectionId: 'abc', text: 'hi' },
    });

    // @ts-expect-error — data is required for tasks that declare .data(...)
    ctx.schedule('send-to-conn', { time: Date.now() + 100 });

    ctx.schedule('send-to-conn', {
      time: Date.now() + 100,
      // @ts-expect-error — wrong data shape
      data: { connectionId: 'abc' },
    });
  });

withScheduled(server('app')).scheduled('bad-handler', (t) => {
  // @ts-expect-error — .run(...) without .data(...) does not accept a data parameter
  return t.run((_ctx, data) => {
    void data;
  });
});

withScheduled(server('app'))
  .scheduled('optional-data', (t) =>
    t
      .data(v.optional(v.object({ label: v.string() })))
      .every(1_000)
      .run((_ctx, data) => {
        if (data) {
          void (data.label satisfies string);
        }
      }),
  )
  .incoming(trigger, (ctx) => {
    ctx.schedule('optional-data', { time: Date.now() + 100 });
    ctx.schedule('optional-data', { time: Date.now() + 100, data: { label: 'x' } });
  });

const grouped = withScheduled(server('app'));

grouped
  .use(
    grouped.group((g) =>
      g.scheduled('group-cleanup', (t) =>
        t.run((ctx) => {
          void ctx.sql;
        }),
      ),
    ),
  )
  .incoming(trigger, (ctx) => {
    ctx.schedule('group-cleanup', { time: Date.now() + 100 });
  });
