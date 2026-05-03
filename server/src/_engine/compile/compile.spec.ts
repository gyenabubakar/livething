import { server } from '~/_builder/server-builder.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { scope } from '~/channel/channel.ts';
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

  it('records a channel key when the channel has its own .replayCustom()', async () => {
    const { withReplayCustom } = await import('~/replay/custom/with.ts');
    const { withDedup } = await import('~/dedup/with.ts');
    const { withSequence } = await import('~/sequence/with.ts');

    const base = withReplayCustom(withChannels(withSequence(withDedup(server('chat')))));
    const def = base
      .sequence({ persist: true })
      .dedup()
      .use(
        base.channel('lobby', (c) =>
          c.outgoing(roomSend).replayCustom((r) => r.onReplay(async () => {})),
        ),
      )
      .build();

    const compiled = compileHandlerDefinition(def);
    expect(compiled.replayClaimedChannelKeys).toEqual(new Set(['lobby']));
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

describe('compile static-name vs family-key collision', () => {
  it('throws when a static channel name collides with a later channel-family key', async () => {
    const { channel, scope } = await import('~/channel/channel.ts');
    // Build a primitive list manually so we can sidestep the builder-level
    // identity-dedup check and exercise the compile-time disjoint check.
    const def = {
      __wskit: 'server' as const,
      primitives: [channel('rooms'), channel(scope('rooms', /^.+$/))],
    } as unknown as Parameters<typeof compileHandlerDefinition>[0];

    expect(() => compileHandlerDefinition(def)).toThrow(/disjoint/);
  });

  it('throws when a channel-family key collides with a later static channel name', async () => {
    const { channel, scope } = await import('~/channel/channel.ts');
    const def = {
      __wskit: 'server' as const,
      primitives: [channel(scope('rooms', /^.+$/)), channel('rooms')],
    } as unknown as Parameters<typeof compileHandlerDefinition>[0];

    expect(() => compileHandlerDefinition(def)).toThrow(/disjoint/);
  });
});

describe('compile reserved-event-name guard', () => {
  it('throws at compile when a primitive uses a reserved event name (event() bypass)', () => {
    // Hand-rolled event-shaped object — bypasses event()'s own assertion.
    const sneaky = {
      __wskit: 'event' as const,
      event: '_subscribe',
      schema: (p: unknown) => p,
    };

    const def = withChannels(server('chat'))
      .outgoing(sneaky as never)
      .build();

    expect(() => compileHandlerDefinition(def)).toThrow(
      /'_subscribe' is a reserved protocol event name/,
    );
  });

  it('refuses reserved names registered inside namespaces', () => {
    const sneakyError = {
      __wskit: 'event' as const,
      event: '_error',
      schema: (p: unknown) => p,
    };
    const base = withNamespaces(server('chat'));
    const def = base
      .use(base.namespace('alerts', (ns) => ns.outgoing(sneakyError as never)))
      .build();

    expect(() => compileHandlerDefinition(def)).toThrow(
      /'_error' is a reserved protocol event name/,
    );
  });

  it('refuses reserved names registered inside channels', () => {
    const sneakyKicked = {
      __wskit: 'event' as const,
      event: '_kicked',
      schema: (p: unknown) => p,
    };
    const base = withChannels(server('chat'));
    const def = base.use(base.channel('lobby', (c) => c.outgoing(sneakyKicked as never))).build();

    expect(() => compileHandlerDefinition(def)).toThrow(
      /'_kicked' is a reserved protocol event name/,
    );
  });

  it('rejects any single-underscore event name at boot, even ones not in the explicit reserved set', () => {
    // Hand-rolled event-shaped object — bypasses event()'s constructor guard.
    const sneaky = {
      __wskit: 'event' as const,
      event: '_my_custom',
      schema: (p: unknown) => p,
    };

    const def = server('chat')
      .outgoing(sneaky as never)
      .build();

    expect(() => compileHandlerDefinition(def)).toThrow(
      /'_my_custom' starts with a reserved single-underscore prefix/,
    );
  });

  it('refuses reserved names registered as a stream nudge (event() bypass)', async () => {
    // A hand-rolled nudge declaration bypasses event() and lands on the
    // stream primitive's nudges array. Without the boot guard a stream
    // could claim '_replay' and swallow real replay frames while active.
    const { withStreams } = await import('~/stream/with.ts');
    const sneakyNudge = {
      event: '_replay',
      validator: undefined,
    };
    const startGo = event('go', (p: unknown) => p as Record<string, unknown>);
    const base = withStreams(server('chat'));
    const streamPrimitive = base.stream(startGo, (s) =>
      s
        .chunk((p: unknown) => p as { tick: number })
        .nudge(sneakyNudge as never)
        .generate(async function* () {
          yield { tick: 1 };
        }),
    );
    const def = base.use(streamPrimitive as never).build();

    expect(() => compileHandlerDefinition(def)).toThrow(
      /'_replay' is a reserved protocol event name.*stream 'go' nudge/,
    );
  });
});

describe('compile family-pattern vs static-name conflict guard', () => {
  it('throws when a family pattern matches a registered static channel name (static first)', () => {
    const base = withChannels(server('chat'));
    const def = base
      .use(base.channel('room:general', (ch) => ch.outgoing(roomSend)))
      .use(
        base.channel(scope('rooms', /^room:.+$/), (ch) =>
          ch.outgoing(event('rm', (p: unknown) => p)),
        ),
      )
      .build();

    expect(() => compileHandlerDefinition(def)).toThrow(
      /Channel family 'rooms' has a pattern that matches the static channel name 'room:general'/,
    );
  });

  it('throws when a family pattern matches a registered static channel name (family first)', () => {
    const base = withChannels(server('chat'));
    const def = base
      .use(
        base.channel(scope('rooms', /^room:.+$/), (ch) =>
          ch.outgoing(event('rm', (p: unknown) => p)),
        ),
      )
      .use(base.channel('room:general', (ch) => ch.outgoing(roomSend)))
      .build();

    expect(() => compileHandlerDefinition(def)).toThrow(
      /Channel family 'rooms' has a pattern that matches the static channel name 'room:general'/,
    );
  });

  it('does not throw when the family pattern excludes every registered static name', () => {
    const base = withChannels(server('chat'));
    const def = base
      .use(base.channel('general', (ch) => ch.outgoing(roomSend)))
      .use(
        base.channel(scope('rooms', /^room:.+$/), (ch) =>
          ch.outgoing(event('rm', (p: unknown) => p)),
        ),
      )
      .build();

    expect(() => compileHandlerDefinition(def)).not.toThrow();
  });
});
