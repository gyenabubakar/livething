/* oxlint-disable @typescript-eslint/no-explicit-any */
import { event } from '~/event.ts';
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

// ─── GroupBuilder ───────────────────────────────────────────

describe('GroupBuilder', () => {
  it('extracts primitives as a GroupPrimitive', () => {
    const base = server('chat').outgoing(message);

    const group = base
      .group()
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi', from: ctx.id });
      })
      .extract();

    expect(group.__wskit).toBe('group');
    expect(group.primitives).toHaveLength(1);
    expect(group.primitives[0]!.__wskit).toBe('incoming');
  });

  it('.use() merges extracted group into parent', () => {
    const base = server('chat').outgoing(message);

    const group = base
      .group()
      .incoming(sendMessage, async () => {})
      .extract();

    const def = base.use(group).build();
    expect(def.primitives).toHaveLength(2);
  });

  it('.done() merges inline group into parent', () => {
    const def = server('chat')
      .outgoing(message)
      .group()
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi', from: ctx.id });
      })
      .done()
      .build();

    expect(def.primitives).toHaveLength(2);
  });

  it('rejects nested groups', () => {
    const base = server('chat').outgoing(message);
    const nested = base
      .group()
      .incoming(sendMessage, async () => {})
      .extract();

    expect(() =>
      base
        .group()
        .use(nested)
        .extract(),
    ).toThrow(/Nested groups are not supported/);
  });

  it('inherits parent outgoing events for ctx.send typing', () => {
    const base = server('chat').outgoing(message).outgoing(notification);

    base.group().incoming(sendMessage, async (ctx) => {
      ctx.send('message', { text: 'hi', from: 'system' });
      ctx.send('notification', { title: 'Hello' });

      // @ts-expect-error — undeclared event
      ctx.send('nope', {});
    });
  });

  it('group can declare its own outgoing events', () => {
    const base = server('chat').outgoing(message);

    base
      .group()
      .outgoing(notification)
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'system' });
        ctx.send('notification', { title: 'Hello' });
      });
  });
});
