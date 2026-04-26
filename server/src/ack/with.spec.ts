import { server } from '~/_builder/server-builder.ts';
import { withAck } from '~/ack/with.ts';
import { event } from '~/event.ts';
import { describe, expect, it } from 'vitest';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

describe('.ack() side-effect', () => {
  it('adds ack primitive to the builder', () => {
    const def = withAck(server('chat'))
      .ack()
      .outgoing(message)
      .incoming(sendMessage, async () => {})
      .build();

    expect(def.primitives).toHaveLength(3);
    expect(def.primitives[0]!.__wskit).toBe('ack');
  });

  it('makes ctx.ack() available in handlers after .ack()', () => {
    withAck(server('chat'))
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
    const base = withAck(server('chat')).ack().outgoing(message);

    base.group((g) =>
      g.incoming(sendMessage, async (ctx) => {
        ctx.ack();
        ctx.send('message', { text: 'hi' });
      }),
    );
  });

  it('.ack() is not available inside .group() (server-only infra)', () => {
    const base = withAck(server('chat')).outgoing(message);
    base.group((g) => {
      expect((g as unknown as { ack?: unknown }).ack).toBeUndefined();
      return g;
    });
  });
});
