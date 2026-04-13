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
    const def = server('chat')
      .namespace('notifications', (n) => n.outgoing(alert).incoming(dismiss, async () => {}))
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

  it('callback form returns to parent for continued chaining', () => {
    const def = server('chat')
      .outgoing(message)
      .namespace('notifications', (n) => n.outgoing(alert))
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'after namespace' });
      })
      .build();

    expect(def.primitives).toHaveLength(3);
  });

  it('.extract() returns NamespacePrimitive for multi-file', () => {
    const base = server('chat').ack().outgoing(message);

    const notifications = base
      .namespace('notifications')
      .outgoing(alert)
      .incoming(dismiss, async (ctx) => {
        ctx.send('alert', { id: '1', msg: 'done' });
      })
      .extract();

    expect(notifications.__wskit).toBe('namespace');

    const def = base.use(notifications).build();
    expect(def.primitives.some((p) => p.__wskit === 'namespace')).toBe(true);
  });

  it('callback overload seals namespace and returns parent builder', () => {
    const def = server('chat')
      .namespace('notifications', (n) => n.outgoing(alert).incoming(dismiss, async () => {}))
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'namespace')).toBe(true);
  });

  it('callback overload types ctx correctly', () => {
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

  it('callback overload allows chaining after namespace', () => {
    const def = server('chat')
      .outgoing(message)
      .namespace('notifications', (n) => n.outgoing(alert))
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'after namespace' });
      })
      .build();

    expect(def.primitives).toHaveLength(3);
  });

  it('rejects duplicate namespace names', () => {
    expect(() =>
      server('chat')
        .namespace('notifications', (n) => n.outgoing(alert))
        .namespace('notifications', (n) => n.outgoing(alert))
        .build(),
    ).toThrow(/Duplicate registration/);
  });
});
