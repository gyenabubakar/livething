import { describe, it, expect } from 'vitest';
import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { t } from '~/t.ts';
import '~/_builder/side-effects/scheduled.ts';

const message = event('message', (p: unknown) => p as { text: string });

describe('.scheduled() side-effect', () => {
  it('adds scheduled primitive with handler', () => {
    const def = server('chat')
      .scheduled('cleanup', async () => {})
      .done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0].__wskit).toBe('scheduled');
  });

  it('accepts every option', () => {
    const def = server('chat')
      .scheduled('cleanup', async () => {}, { every: 60_000, retry: false })
      .done();

    const prim = def.primitives[0] as { taskId: string; options?: { every?: number; retry?: boolean } };
    expect(prim.taskId).toBe('cleanup');
    expect(prim.options?.every).toBe(60_000);
    expect(prim.options?.retry).toBe(false);
  });

  it('accepts type-only declaration form', () => {
    const def = server('chat')
      .scheduled('expire-hold', t<{ orderId: string }>())
      .done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0].__wskit).toBe('scheduled');
  });

  it('allows multiple scheduled tasks with different IDs', () => {
    const def = server('chat')
      .scheduled('cleanup', async () => {})
      .scheduled('expire-hold', async () => {})
      .done();

    expect(def.primitives).toHaveLength(2);
  });

  it('rejects duplicate task IDs', () => {
    expect(() =>
      server('chat')
        .scheduled('cleanup', async () => {})
        .scheduled('cleanup', async () => {})
        .done(),
    ).toThrow(/Duplicate registration/);
  });

  it('chains with other primitives', () => {
    const def = server('chat')
      .outgoing(message)
      .scheduled('cleanup', async () => {}, { every: 60_000 })
      .done();

    expect(def.primitives).toHaveLength(2);
    expect(def.primitives[0].__wskit).toBe('outgoing');
    expect(def.primitives[1].__wskit).toBe('scheduled');
  });

  it('works with GroupBuilder', () => {
    const base = server('chat').outgoing(message);
    const group = base
      .group()
      .scheduled('cleanup', async () => {}, { every: 60_000 })
      .extract();

    const def = base.use(group).done();
    expect(def.primitives.some((p) => p.__wskit === 'scheduled')).toBe(true);
  });
});
