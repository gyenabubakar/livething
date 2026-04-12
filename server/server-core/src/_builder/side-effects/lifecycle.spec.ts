import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { describe, expect, it } from 'vitest';

import '~/_builder/side-effects/ack.ts';
import '~/_builder/side-effects/lifecycle.ts';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

describe('lifecycle side-effects', () => {
  it('.onInit() adds primitive', () => {
    const def = server('chat')
      .onInit(async () => {})
      .done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('onInit');
  });

  it('.onConnect() types ctx from builder state', () => {
    server('chat')
      .ack()
      .outgoing(message)
      .onConnect(async (ctx) => {
        ctx.ack();
        ctx.send('message', { text: 'welcome' });
      });
  });

  it('.onDisconnect() types ctx from builder state', () => {
    server('chat')
      .outgoing(message)
      .onDisconnect(async (ctx) => {
        ctx.send('message', { text: 'goodbye' });

        // @ts-expect-error — ack not registered
        ctx.ack();
      });
  });

  it('.onShutdown() adds primitive', () => {
    const def = server('chat')
      .onShutdown(async () => {})
      .done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('onShutdown');
  });

  it('.onError() types ctx from builder state', () => {
    server('chat')
      .outgoing(message)
      .onError(async (ctx, error, event) => {
        void error;
        void event;
        ctx.send('message', { text: 'error occurred' });
      });
  });

  it('.onUpgrade() adds primitive', () => {
    const def = server('chat')
      .onUpgrade(async (_req) => {
        return { meta: { userId: 'abc' } };
      })
      .done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('onUpgrade');
  });

  it('.onBinary() types ctx from builder state', () => {
    server('chat')
      .outgoing(message)
      .onBinary(async (ctx, data) => {
        void data;
        ctx.send('message', { text: 'got binary' });
      });
  });

  it('.onValidationError() types ctx from builder state', () => {
    server('chat')
      .outgoing(message)
      .onValidationError(async (ctx, event, error) => {
        void event;
        void error;
        ctx.send('message', { text: 'validation failed' });
      });
  });

  it('all lifecycle hooks chain together', () => {
    const def = server('chat')
      .outgoing(message)
      .onInit(async () => {})
      .onUpgrade(async () => ({ meta: {} }))
      .onConnect(async () => {})
      .onDisconnect(async () => {})
      .onShutdown(async () => {})
      .onError(async () => {})
      .onBinary(async () => {})
      .onValidationError(async () => {})
      .incoming(sendMessage, async () => {})
      .done();

    expect(def.primitives).toHaveLength(10);
  });

  it('rejects duplicate lifecycle hooks', () => {
    expect(() =>
      server('chat')
        .onConnect(async () => {})
        .onConnect(async () => {})
        .done(),
    ).toThrow(/Duplicate registration/);
  });

  it('works with GroupBuilder', () => {
    const base = server('chat').ack().outgoing(message);
    const group = base
      .group()
      .onConnect(async (ctx) => {
        ctx.ack();
        ctx.send('message', { text: 'hi' });
      })
      .extract();

    const def = base.use(group).done();
    expect(def.primitives.some((p) => p.__wskit === 'onConnect')).toBe(true);
  });
});
