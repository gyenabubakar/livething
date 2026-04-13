import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { describe, expect, it } from 'vitest';

import '~/_builder/side-effects/ack.ts';
import '~/_builder/side-effects/namespaces.ts';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });
const alert = event('alert', (p: unknown) => p as { id: string; msg: string });
const dismiss = event('dismiss', (p: unknown) => p as { id: string });

describe('.namespace() side-effect', () => {
  it('adds namespace primitive', () => {
    const s = server('chat');
    const def = s
      .use(s.namespace('notifications', (n) => n.outgoing(alert).incoming(dismiss, async () => {})))
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'namespace')).toBe(true);
  });

  it('types namespace handler ctx with parent outgoing events', () => {
    server('chat')
      .ack()
      .outgoing(message)
      .namespace('notifications', (n) =>
        n.outgoing(alert).incoming(dismiss, async (ctx) => {
          ctx.send('message', { text: 'dismissed' });
          ctx.send('alert', { id: '1', msg: 'hi' });
        }),
      );
  });

  it('namespace-local outgoing scoped correctly', () => {
    server('chat').namespace('notifications', (n) =>
      n.outgoing(alert).incoming(dismiss, async (ctx) => {
        ctx.send('alert', { id: '1', msg: 'hi' });

        // @ts-expect-error — 'message' not in this namespace scope
        ctx.send('message', { text: 'hi' });
      }),
    );
  });

  it('callback form returns namespace primitive for .use()', () => {
    const base = server('chat').outgoing(message);
    const def = base
      .use(base.namespace('notifications', (n) => n.outgoing(alert)))
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'after namespace' });
      })
      .build();

    expect(def.primitives).toHaveLength(3);
  });

  it('callback form returns namespace primitive for multi-file', () => {
    const s = server('chat').ack().outgoing(message);
    const def = s
      .use(
        s.namespace('notifications', (n) =>
          n.outgoing(alert).incoming(dismiss, async (ctx) => {
            ctx.send('alert', { id: '1', msg: 'done' });
          }),
        ),
      )
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'namespace')).toBe(true);
  });

  it('rejects duplicate namespace names', () => {
    const s = server('chat');
    expect(() =>
      s
        .use(s.namespace('notifications', (n) => n.outgoing(alert)))
        .use(s.namespace('notifications', (n) => n.outgoing(alert)))
        .build(),
    ).toThrow(/Duplicate registration/);
  });
});
