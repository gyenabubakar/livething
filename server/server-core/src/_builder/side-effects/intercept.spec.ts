import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { describe, expect, it } from 'vitest';

import '~/_builder/side-effects/intercept.ts';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

describe('.intercept() side-effect', () => {
  it('adds pre-validation intercept', () => {
    const def = server('chat')
      .intercept(async (_ctx, message) => {
        void message.event;
      })
      .done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('intercept');
    expect((def.primitives[0] as unknown as { mode: string }).mode).toBe('pre');
  });

  it('adds post-validation intercept', () => {
    const def = server('chat')
      .outgoing(message)
      .incoming(sendMessage, async () => {})
      .intercept('send-message', async (_ctx, payload) => {
        void payload;
      })
      .done();

    expect(def.primitives).toHaveLength(3);
    expect(def.primitives[2]!.__wskit).toBe('intercept');
    expect((def.primitives[2] as unknown as { mode: string }).mode).toBe('post');
  });

  it('pre-intercept does not change TState', () => {
    server('chat')
      .outgoing(message)
      .intercept(async (ctx) => {
        ctx.send('message', { text: 'intercepted' });
      })
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'after intercept' });
      });
  });

  it('works with GroupBuilder', () => {
    const base = server('chat').outgoing(message);
    const group = base
      .group()
      .intercept(async () => {})
      .extract();

    const def = base.use(group).done();
    expect(def.primitives.some((p) => p.__wskit === 'intercept')).toBe(true);
  });
});
