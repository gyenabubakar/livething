import { server } from '~/_builder/server-builder.ts';
import { withAck } from '~/ack/with.ts';
import { event } from '~/event.ts';
import { withLifecycle } from '~/lifecycle/with.ts';
import { describe, expect, it } from 'vitest';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

describe('lifecycle side-effects', () => {
  it('.onInit() adds primitive', () => {
    const def = withLifecycle(server('chat'))
      .onInit(async () => {})
      .build();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('onInit');
  });

  it('.onConnect() types ctx from builder state', () => {
    withAck(withLifecycle(server('chat')))
      .ack()
      .outgoing(message)
      .onConnect(async (ctx) => {
        ctx.ack();
        ctx.send('message', { text: 'welcome' });
      });
  });

  it('.onDisconnect() types ctx from builder state', () => {
    withLifecycle(server('chat'))
      .outgoing(message)
      .onDisconnect(async (ctx) => {
        ctx.send('message', { text: 'goodbye' });

        // @ts-expect-error — ack not registered
        ctx.ack();
      });
  });

  it('.onShutdown() adds primitive', () => {
    const def = withLifecycle(server('chat'))
      .onShutdown(async () => {})
      .build();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('onShutdown');
  });

  it('.onError() types ctx from builder state', () => {
    withLifecycle(server('chat'))
      .outgoing(message)
      .onError(async (ctx, error, event) => {
        void error;
        void event;
        ctx.send('message', { text: 'error occurred' });
      });
  });

  it('.onUpgrade() adds primitive', () => {
    const def = withLifecycle(server('chat'))
      .onUpgrade(async (_req) => {
        return { meta: { userId: 'abc' } };
      })
      .build();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('onUpgrade');
  });

  it('.onBinary() types ctx from builder state', () => {
    withLifecycle(server('chat'))
      .outgoing(message)
      .onBinary(async (ctx, data) => {
        void data;
        ctx.send('message', { text: 'got binary' });
      });
  });

  it('.onValidationError() types ctx from builder state', () => {
    withLifecycle(server('chat'))
      .outgoing(message)
      .onValidationError(async (ctx, event, error) => {
        void event;
        void error;
        ctx.send('message', { text: 'validation failed' });
      });
  });

  it('all lifecycle hooks chain together', () => {
    const def = withLifecycle(server('chat'))
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
      .build();

    expect(def.primitives).toHaveLength(10);
  });

  it('rejects duplicate lifecycle hooks', () => {
    expect(() =>
      withLifecycle(server('chat'))
        .onConnect(async () => {})
        .onConnect(async () => {})
        .build(),
    ).toThrow(/Duplicate registration/);
  });

  it('works with GroupBuilder', () => {
    const base = withAck(withLifecycle(server('chat')))
      .ack()
      .outgoing(message);
    const def = base
      .use(
        base.group((g) =>
          g.onConnect(async (ctx) => {
            ctx.ack();
            ctx.send('message', { text: 'hi' });
          }),
        ),
      )
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'onConnect')).toBe(true);
  });
});
