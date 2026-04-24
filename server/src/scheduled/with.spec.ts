import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { withScheduled } from '~/scheduled/with.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

const message = event('message', (p: unknown) => p as { text: string });

describe('.scheduled() side-effect', () => {
  it('adds scheduled primitive with handler', () => {
    const def = withScheduled(server('chat'))
      .scheduled('cleanup', (t) => t.run(async () => {}))
      .build();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('scheduled');
  });

  it('accepts every option', () => {
    const def = withScheduled(server('chat'))
      .scheduled('cleanup', (t) =>
        t
          .every(60_000)
          .retry(false)
          .run(async () => {}),
      )
      .build();

    const prim = def.primitives[0] as unknown as {
      taskId: string;
      options?: { every?: number; retry?: boolean };
    };
    expect(prim.taskId).toBe('cleanup');
    expect(prim.options?.every).toBe(60_000);
    expect(prim.options?.retry).toBe(false);
  });

  it('accepts data-backed declarations', () => {
    const def = withScheduled(server('chat'))
      .scheduled('expire-hold', (t) =>
        t.data(v.object({ orderId: v.string() })).run(async (_ctx, data) => {
          void data.orderId;
        }),
      )
      .build();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('scheduled');
  });

  it('allows multiple scheduled tasks with different IDs', () => {
    const def = withScheduled(server('chat'))
      .scheduled('cleanup', (t) => t.run(async () => {}))
      .scheduled('expire-hold', (t) => t.run(async () => {}))
      .build();

    expect(def.primitives).toHaveLength(2);
  });

  it('rejects duplicate task IDs', () => {
    expect(() =>
      withScheduled(server('chat'))
        .scheduled('cleanup', (t) => t.run(async () => {}))
        .scheduled('cleanup', (t) => t.run(async () => {}))
        .build(),
    ).toThrow(/Duplicate registration/);
  });

  it('chains with other primitives', () => {
    const def = withScheduled(server('chat'))
      .outgoing(message)
      .scheduled('cleanup', (t) => t.every(60_000).run(async () => {}))
      .build();

    expect(def.primitives).toHaveLength(2);
    expect(def.primitives[0]!.__wskit).toBe('outgoing');
    expect(def.primitives[1]!.__wskit).toBe('scheduled');
  });

  it('works with GroupBuilder', () => {
    const base = withScheduled(server('chat')).outgoing(message);
    const def = base
      .use(base.group((g) => g.scheduled('cleanup', (t) => t.every(60_000).run(async () => {}))))
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'scheduled')).toBe(true);
  });
});
