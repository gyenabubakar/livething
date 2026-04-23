/* oxlint-disable @typescript-eslint/no-explicit-any */
import { event } from '~/event.ts';
import { server as fullServer } from '~/full/index.ts';
import { describe, expect, it } from 'vitest';
import { server } from './server-builder.ts';

const message = event('message', (p: unknown) => p as { text: string; from: string });
const notification = event('notification', (p: unknown) => p as { title: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });
const typing = event('typing', (p: unknown) => p as { userId: string });

// ─── event() ────────────────────────────────────────────────

describe('event()', () => {
  it('creates an EventContract with name and schema', () => {
    expect(message.__wskit).toBe('event');
    expect(message.event).toBe('message');
    expect(typeof message.schema).toBe('function');
  });
});

// ─── Runtime behavior ───────────────────────────────────────

describe('ServerBuilder — runtime', () => {
  it('produces a frozen ServerDefinition', () => {
    const def = server('chat')
      .outgoing(message)
      .incoming(sendMessage, async () => {})
      .build();

    expect(def.__wskit).toBe('server');
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.primitives)).toBe(true);
  });

  it('preserves declaration order', () => {
    const def = server('chat')
      .outgoing(message)
      .outgoing(notification)
      .incoming(sendMessage, async () => {})
      .build();

    expect(def.primitives).toHaveLength(3);
    expect(def.primitives[0]!.__wskit).toBe('outgoing');
    expect(def.primitives[1]!.__wskit).toBe('outgoing');
    expect(def.primitives[2]!.__wskit).toBe('incoming');
  });

  it('catches duplicate incoming registrations', () => {
    expect(() =>
      server('chat')
        .incoming(sendMessage, async () => {})
        .incoming(sendMessage, async () => {})
        .build(),
    ).toThrow(/Duplicate registration/);
  });

  it('allows different incoming events', () => {
    expect(() =>
      server('chat')
        .incoming(sendMessage, async () => {})
        .incoming(typing, async () => {})
        .build(),
    ).not.toThrow();
  });
});

// ─── Type inference ─────────────────────────────────────────

describe('ServerBuilder — type inference', () => {
  it('types ctx.send event name against registered outgoing events', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'system' });

        // @ts-expect-error — 'unknown-event' not declared
        ctx.send('unknown-event', {});
      });
  });

  it('types ctx.send payload shape against outgoing declaration', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — missing 'from' field
        ctx.send('message', { text: 'hi' });
      });
  });

  it('accumulates multiple outgoing events', () => {
    server('chat')
      .outgoing(message)
      .outgoing(notification)
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'system' });
        ctx.send('notification', { title: 'Welcome' });

        // @ts-expect-error — still rejects undeclared events
        ctx.send('nope', {});
      });
  });

  it('types incoming handler payload from event schema', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (_ctx, payload) => {
        const text: string = payload.text;
        void text;

        // @ts-expect-error — 'nonexistent' does not exist on payload
        payload.nonexistent;
      });
  });

  it('ctx.ack is a type error without ack primitive', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — ack() not registered on builder
        ctx.ack();
      });
  });
});

// ─── full/index server ──────────────────────────────────────

describe('server from full/index', () => {
  it('exposes every feature method without manual with* wrappers', () => {
    const builder = fullServer('test');
    expect(typeof builder.channel).toBe('function');
    expect(typeof builder.namespace).toBe('function');
    expect(typeof builder.stream).toBe('function');
    expect(typeof builder.request).toBe('function');
    expect(typeof builder.replay).toBe('function');
    expect(typeof builder.scheduled).toBe('function');
    expect(typeof builder.intercept).toBe('function');
    expect(typeof builder.onConnect).toBe('function');
    expect(typeof builder.ack).toBe('function');
    expect(typeof builder.dedup).toBe('function');
    expect(typeof builder.heartbeat).toBe('function');
    expect(typeof builder.sequence).toBe('function');
    expect(typeof builder.hibernation).toBe('function');
  });
});

// ─── event() identity chain ─────────────────────────────────

describe('event() identity chain', () => {
  it('wire name flows into primitive __identity[1] when mounted via .outgoing()', () => {
    const greet = event('greet', (p: unknown) => p as {});
    const def = server('x').outgoing(greet).build();
    expect(def.primitives[0]?.__identity[1]).toBe('greet');
  });
});

// ─── GroupBuilder ───────────────────────────────────────────

describe('GroupBuilder', () => {
  it('callback form merges inline group into parent', () => {
    const base = server('chat').outgoing(message);
    const def = base
      .use(
        base.group((g) =>
          g.incoming(sendMessage, async (ctx) => {
            ctx.send('message', { text: 'hi', from: ctx.id });
          }),
        ),
      )
      .build();

    expect(def.primitives).toHaveLength(2);
  });

  it('callback types ctx correctly', () => {
    server('chat')
      .outgoing(message)
      .outgoing(notification)
      .group((g) =>
        g.incoming(sendMessage, async (ctx) => {
          ctx.send('message', { text: 'hi', from: 'system' });
          ctx.send('notification', { title: 'Hello' });

          // @ts-expect-error — undeclared event
          ctx.send('nope', {});
        }),
      );
  });

  it('inherits parent outgoing events for ctx.send typing', () => {
    server('chat')
      .outgoing(message)
      .outgoing(notification)
      .group((g) =>
        g.incoming(sendMessage, async (ctx) => {
          ctx.send('message', { text: 'hi', from: 'system' });
          ctx.send('notification', { title: 'Hello' });

          // @ts-expect-error — undeclared event
          ctx.send('nope', {});
        }),
      );
  });

  it('group can declare its own outgoing events', () => {
    server('chat')
      .outgoing(message)
      .group((g) =>
        g.outgoing(notification).incoming(sendMessage, async (ctx) => {
          ctx.send('message', { text: 'hi', from: 'system' });
          ctx.send('notification', { title: 'Hello' });
        }),
      );
  });

  it('GroupBuilder.use() rejects nested groups at compile time', () => {
    const base = server('chat').outgoing(message);
    const outerGroup = base.group((g) => g.outgoing(notification));

    base.group((g) => {
      // @ts-expect-error — groups cannot be nested inside other groups
      return g.use(outerGroup);
    });
  });
});
