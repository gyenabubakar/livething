import { describe, it, expect } from 'vitest';
import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import '~/_builder/side-effects/ack.ts';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

describe('.ack() side-effect', () => {
  it('adds ack primitive to the builder', () => {
    const def = server('chat')
      .ack()
      .outgoing(message)
      .incoming(sendMessage, async () => {})
      .done();

    expect(def.primitives).toHaveLength(3);
    expect(def.primitives[0].__wskit).toBe('ack');
  });

  it('makes ctx.ack() available in handlers after .ack()', () => {
    server('chat')
      .ack()
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        ctx.ack();
        ctx.send('message', { text: 'hi' });
      });
  });

  it('ctx.ack() is a type error without .ack()', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — .ack() not called on builder
        ctx.ack();
      });
  });

  it('works with GroupBuilder', () => {
    const base = server('chat').ack().outgoing(message);

    base
      .group()
      .incoming(sendMessage, async (ctx) => {
        ctx.ack();
        ctx.send('message', { text: 'hi' });
      });
  });

  it('ack registered in group is detected by .done()', () => {
    const base = server('chat').outgoing(message);
    const group = base.group().ack().extract();

    const def = base.use(group).done();
    expect(def.primitives.some((p) => p.__wskit === 'ack')).toBe(true);
  });
});
