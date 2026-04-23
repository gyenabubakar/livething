import { server } from '~/_builder/server-builder.ts';
import { withAck } from '~/ack/with.ts';
import { event } from '~/event.ts';
import { withRequests } from '~/request/with.ts';
import { describe, expect, it } from 'vitest';

const message = event('message', (p: unknown) => p as { text: string });
const ping = event('ping', (p: unknown) => p as { ts: number });
function pongSchema(p: unknown) {
  return p as { ts: number; serverTs: number };
}

describe('.request() side-effect', () => {
  it('adds request primitive', () => {
    const def = withRequests(server('chat'))
      .request(ping, pongSchema, async (ctx, payload) => {
        ctx.respond({ ts: payload.ts, serverTs: Date.now() });
      })
      .build();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('request');
  });

  it('types handler ctx from builder state', () => {
    withAck(withRequests(server('chat')))
      .ack()
      .outgoing(message)
      .request(ping, pongSchema, async (ctx, payload) => {
        ctx.ack();
        ctx.send('message', { text: 'pong' });
        ctx.respond({ ts: payload.ts, serverTs: Date.now() });
      });
  });

  it('types handler payload from event schema', () => {
    withRequests(server('chat')).request(ping, pongSchema, async (ctx, payload) => {
      const ts: number = payload.ts;
      void ts;

      // @ts-expect-error — 'nonexistent' not on payload
      payload.nonexistent;

      ctx.respond({ ts: payload.ts, serverTs: Date.now() });
    });
  });

  it('rejects duplicate request event names', () => {
    expect(() =>
      withRequests(server('chat'))
        .request(ping, pongSchema, async (ctx, p) => {
          ctx.respond({ ts: p.ts, serverTs: 0 });
        })
        .request(ping, pongSchema, async (ctx, p) => {
          ctx.respond({ ts: p.ts, serverTs: 0 });
        })
        .build(),
    ).toThrow(/Duplicate registration/);
  });

  it('works with GroupBuilder', () => {
    const base = withAck(withRequests(server('chat')))
      .ack()
      .outgoing(message);
    const def = base
      .use(
        base.group((g) =>
          g.request(ping, pongSchema, async (ctx, payload) => {
            ctx.ack();
            ctx.respond({ ts: payload.ts, serverTs: Date.now() });
          }),
        ),
      )
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'request')).toBe(true);
  });
});
