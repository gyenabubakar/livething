import { server } from '~/_builder/server-builder.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { withChannels } from '~/channel/with.ts';
import { event } from '~/event.ts';
import { withIntercept } from '~/intercept/with.ts';
import { withNamespaces } from '~/namespace/with.ts';
import { describe, expect, it } from 'vitest';

const sendMessage = event('send-message', (p: unknown) => p as { text: string });
const orphan = event('orphan-event', (p: unknown) => p as { text: string });
const roomSend = event('room-send', (p: unknown) => p as { text: string });

describe('compile post-intercept validation', () => {
  it('throws when a top-level post-intercept has no matching handler', () => {
    const def = withIntercept(server('chat'))
      .intercept(orphan, async (_ctx, payload) => {
        void payload;
      })
      .build();

    expect(() => compileHandlerDefinition(def)).toThrow(
      /Post-intercept registered for 'orphan-event' in top-level/,
    );
  });

  it('does not throw when a matching top-level handler exists', () => {
    const def = withIntercept(server('chat'))
      .outgoing(sendMessage)
      .incoming(sendMessage, async () => {})
      .intercept('send-message', async (_ctx, payload) => {
        void payload;
      })
      .build();

    expect(() => compileHandlerDefinition(def)).not.toThrow();
  });

  it('throws when a channel post-intercept has no matching handler in that channel', () => {
    const base = withIntercept(withChannels(server('chat')));
    const def = base
      .use(
        base.channel('lobby', (c) =>
          c.intercept(orphan, async (_ctx, payload) => {
            void payload;
          }),
        ),
      )
      .build();

    expect(() => compileHandlerDefinition(def)).toThrow(
      /Post-intercept registered for 'orphan-event' in channel 'lobby'/,
    );
  });

  it('does not throw when channel post-intercept has a matching channel handler', () => {
    const base = withIntercept(withChannels(server('chat')));
    const def = base
      .use(
        base.channel('lobby', (c) =>
          c
            .outgoing(roomSend)
            .incoming(roomSend, async () => {})
            .intercept('room-send', async (_ctx, payload) => {
              void payload;
            }),
        ),
      )
      .build();

    expect(() => compileHandlerDefinition(def)).not.toThrow();
  });

  it('throws when a namespace post-intercept has no matching handler in that namespace', () => {
    const base = withIntercept(withNamespaces(server('chat')));
    const def = base
      .use(
        base.namespace('ai', (n) =>
          n.intercept(orphan, async (_ctx, payload) => {
            void payload;
          }),
        ),
      )
      .build();

    expect(() => compileHandlerDefinition(def)).toThrow(
      /Post-intercept registered for 'orphan-event' in namespace 'ai'/,
    );
  });

  it('does not throw when namespace post-intercept has a matching namespace handler', () => {
    const base = withIntercept(withNamespaces(server('chat')));
    const def = base
      .use(
        base.namespace('ai', (n) =>
          n
            .incoming(sendMessage, async () => {})
            .intercept('send-message', async (_ctx, payload) => {
              void payload;
            }),
        ),
      )
      .build();

    expect(() => compileHandlerDefinition(def)).not.toThrow();
  });

  it('does not throw when post-intercept targets a module-prefixed event with a matching handler', () => {
    const moduleEvent = event('__auth:login', (p: unknown) => p as { token: string });
    const def = withIntercept(server('chat'))
      .incoming(moduleEvent, async () => {})
      .intercept(moduleEvent, async (_ctx, payload) => {
        void payload;
      })
      .build();

    expect(() => compileHandlerDefinition(def)).not.toThrow();
  });
});

describe('compile replayClaimedChannelKeys', () => {
  it('is empty when no replay primitive is registered', async () => {
    const { withReplay } = await import('~/replay/with.ts');
    const def = withReplay(server('chat')).build();
    const compiled = compileHandlerDefinition(def);
    expect(compiled.replayClaimedChannelKeys).toEqual(new Set());
  });

  it('is empty when replay is registered only at the server level (cascade default)', async () => {
    const { withReplay } = await import('~/replay/with.ts');
    const { withDedup } = await import('~/dedup/with.ts');
    const { withSequence } = await import('~/sequence/with.ts');

    const def = withReplay(withSequence(withDedup(server('chat'))))
      .sequence({ persist: true })
      .dedup()
      .replay((r) => r)
      .build();

    const compiled = compileHandlerDefinition(def);
    expect(compiled.replayClaimedChannelKeys).toEqual(new Set());
  });

  it('records a static channel key when the channel has its own .replay()', async () => {
    const { withReplay } = await import('~/replay/with.ts');
    const { withDedup } = await import('~/dedup/with.ts');
    const { withSequence } = await import('~/sequence/with.ts');

    const base = withReplay(withChannels(withSequence(withDedup(server('chat')))));
    const def = base
      .sequence({ persist: true })
      .dedup()
      .use(base.channel('lobby', (c) => c.outgoing(roomSend).replay((r) => r)))
      .build();

    const compiled = compileHandlerDefinition(def);
    expect(compiled.replayClaimedChannelKeys).toEqual(new Set(['lobby']));
  });

  it('records a channel scope key when the channel family has its own .replay()', async () => {
    const { withReplay } = await import('~/replay/with.ts');
    const { withDedup } = await import('~/dedup/with.ts');
    const { withSequence } = await import('~/sequence/with.ts');
    const { scope } = await import('~/channel/channel.ts');

    const base = withReplay(withChannels(withSequence(withDedup(server('chat')))));
    const def = base
      .sequence({ persist: true })
      .dedup()
      .use(base.channel(scope('rooms', /^room-.+$/), (c) => c.outgoing(roomSend).replay((r) => r)))
      .build();

    const compiled = compileHandlerDefinition(def);
    expect(compiled.replayClaimedChannelKeys).toEqual(new Set(['rooms']));
  });

  it('records a channel that opts out via .replay(false)', async () => {
    const { withReplay } = await import('~/replay/with.ts');
    const { withDedup } = await import('~/dedup/with.ts');
    const { withSequence } = await import('~/sequence/with.ts');

    const base = withReplay(withChannels(withSequence(withDedup(server('chat')))));
    const def = base
      .sequence({ persist: true })
      .dedup()
      .use(base.channel('public-room', (c) => c.outgoing(roomSend).replay(false)))
      .build();

    const compiled = compileHandlerDefinition(def);
    expect(compiled.replayClaimedChannelKeys).toEqual(new Set(['public-room']));
  });

  it('records every channel that registered or disabled replay independently', async () => {
    const { withReplay } = await import('~/replay/with.ts');
    const { withDedup } = await import('~/dedup/with.ts');
    const { withSequence } = await import('~/sequence/with.ts');
    const { scope } = await import('~/channel/channel.ts');

    const base = withReplay(withChannels(withSequence(withDedup(server('chat')))));
    const def = base
      .sequence({ persist: true })
      .dedup()
      .use(base.channel('lobby', (c) => c.outgoing(roomSend).replay((r) => r)))
      .use(base.channel(scope('rooms', /^room-.+$/), (c) => c.outgoing(roomSend).replay((r) => r)))
      .use(base.channel('public-room', (c) => c.outgoing(roomSend).replay(false)))
      .build();

    const compiled = compileHandlerDefinition(def);
    expect(compiled.replayClaimedChannelKeys).toEqual(new Set(['lobby', 'rooms', 'public-room']));
  });
});
