import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { describe, expect, it } from 'vitest';

import '~/_builder/side-effects/ack.ts';
import '~/_builder/side-effects/requests.ts';

const message = event('message', (p: unknown) => p as { text: string });
const ping = event('ping', (p: unknown) => p as { ts: number });
function pongSchema(p: unknown) {
  return p as { ts: number; serverTs: number };
}

describe('.reply() side-effect', () => {
  it('adds request primitive', () => {
    const def = server('chat')
      .reply(ping, pongSchema, async (_ctx, payload) => {
        return { ts: payload.ts, serverTs: Date.now() };
      })
      .done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('request');
  });

  it('types handler ctx from builder state', () => {
    server('chat')
      .ack()
      .outgoing(message)
      .reply(ping, pongSchema, async (ctx, payload) => {
        ctx.ack();
        ctx.send('message', { text: 'pong' });
        return { ts: payload.ts, serverTs: Date.now() };
      });
  });

  it('types handler payload from event schema', () => {
    server('chat').reply(ping, pongSchema, async (_ctx, payload) => {
      const ts: number = payload.ts;
      void ts;

      // @ts-expect-error — 'nonexistent' not on payload
      payload.nonexistent;

      return { ts: payload.ts, serverTs: Date.now() };
    });
  });

  it('rejects duplicate request event names', () => {
    expect(() =>
      server('chat')
        .reply(ping, pongSchema, async (_ctx, payload) => ({ ts: payload.ts, serverTs: 0 }))
        .reply(ping, pongSchema, async (_ctx, payload) => ({ ts: payload.ts, serverTs: 0 }))
        .done(),
    ).toThrow(/Duplicate registration/);
  });

  it('works with GroupBuilder', () => {
    const base = server('chat').ack().outgoing(message);
    const group = base
      .group()
      .reply(ping, pongSchema, async (ctx, payload) => {
        ctx.ack();
        return { ts: payload.ts, serverTs: Date.now() };
      })
      .extract();

    const def = base.use(group).done();
    expect(def.primitives.some((p) => p.__wskit === 'request')).toBe(true);
  });
});
