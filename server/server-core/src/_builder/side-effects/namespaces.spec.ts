import { describe, it, expect } from 'vitest';
import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import '~/_builder/side-effects/ack.ts';
import '~/_builder/side-effects/namespaces.ts';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });
const alert = event('alert', (p: unknown) => p as { id: string; msg: string });
const dismiss = event('dismiss', (p: unknown) => p as { id: string });

describe('.namespace() side-effect', () => {
  it('adds namespace primitive', () => {
    const def = server('chat')
      .namespace('notifications')
        .outgoing(alert)
        .incoming(dismiss, async () => {})
        .done()
      .done();

    expect(def.primitives.some((p) => p.__wskit === 'namespace')).toBe(true);
  });

  it('types namespace handler ctx with parent outgoing events', () => {
    server('chat')
      .ack()
      .outgoing(message)
      .namespace('notifications')
        .outgoing(alert)
        .incoming(dismiss, async (ctx) => {
          ctx.send('message', { text: 'dismissed' });
          ctx.send('alert', { id: '1', msg: 'hi' });
          ctx.ack();
        })
        .done();
  });

  it('namespace-local outgoing scoped correctly', () => {
    server('chat')
      .namespace('notifications')
        .outgoing(alert)
        .incoming(dismiss, async (ctx) => {
          ctx.send('alert', { id: '1', msg: 'hi' });

          // @ts-expect-error — 'message' not in this namespace scope
          ctx.send('message', { text: 'hi' });
        })
        .done();
  });

  it('.done() returns to parent builder', () => {
    const def = server('chat')
      .outgoing(message)
      .namespace('notifications')
        .outgoing(alert)
        .done()
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'after namespace' });
      })
      .done();

    expect(def.primitives).toHaveLength(3);
  });

  it('.extract() returns NamespacePrimitive for multi-file', () => {
    const base = server('chat').ack().outgoing(message);

    const notifications = base
      .namespace('notifications')
      .outgoing(alert)
      .incoming(dismiss, async (ctx) => {
        ctx.ack();
        ctx.send('alert', { id: '1', msg: 'done' });
      })
      .extract();

    expect(notifications.__wskit).toBe('namespace');

    const def = base.use(notifications).done();
    expect(def.primitives.some((p) => p.__wskit === 'namespace')).toBe(true);
  });

  it('rejects duplicate namespace names', () => {
    expect(() =>
      server('chat')
        .namespace('notifications')
          .outgoing(alert)
          .done()
        .namespace('notifications')
          .outgoing(alert)
          .done()
        .done(),
    ).toThrow(/Duplicate registration/);
  });
});
