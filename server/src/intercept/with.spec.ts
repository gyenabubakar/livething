import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { withIntercept } from '~/intercept/with.ts';
import { withNamespaces } from '~/namespace/with.ts';
import { describe, expect, it } from 'vitest';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

describe('.intercept() side-effect', () => {
  it('adds pre-validation intercept', () => {
    const def = withIntercept(server('chat'))
      .intercept(async (_ctx, message) => {
        void message.event;
      })
      .build();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('intercept');
    expect((def.primitives[0] as unknown as { mode: string }).mode).toBe('pre');
  });

  it('adds post-validation intercept', () => {
    const def = withIntercept(server('chat'))
      .outgoing(message)
      .incoming(sendMessage, async () => {})
      .intercept('send-message', async (_ctx, payload) => {
        void payload;
      })
      .build();

    expect(def.primitives).toHaveLength(3);
    expect(def.primitives[2]!.__wskit).toBe('intercept');
    expect((def.primitives[2] as unknown as { mode: string }).mode).toBe('post');
  });

  it('pre-intercept does not change TState', () => {
    withIntercept(server('chat'))
      .outgoing(message)
      .intercept(async (ctx) => {
        ctx.send('message', { text: 'intercepted' });
      })
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'after intercept' });
      });
  });

  it('works with GroupBuilder', () => {
    const base = withIntercept(server('chat')).outgoing(message);
    const def = base.use(base.group((g) => g.intercept(async () => {}))).build();

    expect(def.primitives.some((p) => p.__wskit === 'intercept')).toBe(true);
  });

  it('works with NamespaceBuilder (pre-intercept)', () => {
    const base = withIntercept(withNamespaces(server('chat'))).outgoing(message);
    const def = base
      .use(
        base.namespace('ai', (n) =>
          n.outgoing(message).intercept((_ctx, msg) => {
            void msg.event;
            void msg.payload;
          }),
        ),
      )
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'namespace')).toBe(true);
  });

  it('works with NamespaceBuilder (post-intercept)', () => {
    const base = withIntercept(withNamespaces(server('chat'))).outgoing(message);
    base.namespace('ai', (n) =>
      n
        .outgoing(message)
        .incoming(sendMessage, async () => {})
        .intercept('send-message', (_ctx, payload) => {
          const text: string = payload.text;
          void text;
          return payload;
        }),
    );
  });
});
