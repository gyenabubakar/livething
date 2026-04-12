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

describe('.request() side-effect', () => {
  it('adds request primitive', () => {
    const def = server('chat')
      .request(ping, pongSchema, async (ctx, payload) => {
        ctx.respond({ ts: payload.ts, serverTs: Date.now() });
      })
      .build();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('request');
  });

  it('types handler ctx from builder state', () => {
    server('chat')
      .ack()
      .outgoing(message)
      .request(ping, pongSchema, async (ctx, payload) => {
        ctx.ack();
        ctx.send('message', { text: 'pong' });
        ctx.respond({ ts: payload.ts, serverTs: Date.now() });
      });
  });

  it('types handler payload from event schema', () => {
    server('chat').request(ping, pongSchema, async (ctx, payload) => {
      const ts: number = payload.ts;
      void ts;

      // @ts-expect-error — 'nonexistent' not on payload
      payload.nonexistent;

      ctx.respond({ ts: payload.ts, serverTs: Date.now() });
    });
  });

  it('rejects duplicate request event names', () => {
    expect(() =>
      server('chat')
        .request(ping, pongSchema, async (ctx, p) => { ctx.respond({ ts: p.ts, serverTs: 0 }); })
        .request(ping, pongSchema, async (ctx, p) => { ctx.respond({ ts: p.ts, serverTs: 0 }); })
        .build(),
    ).toThrow(/Duplicate registration/);
  });

  it('works with GroupBuilder', () => {
    const base = server('chat').ack().outgoing(message);
    const group = base
      .group()
      .request(ping, pongSchema, async (ctx, payload) => {
        ctx.ack();
        ctx.respond({ ts: payload.ts, serverTs: Date.now() });
      })
      .extract();

    const def = base.use(group).build();
    expect(def.primitives.some((p) => p.__wskit === 'request')).toBe(true);
  });
});
