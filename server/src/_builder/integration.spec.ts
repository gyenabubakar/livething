/* oxlint-disable @typescript-eslint/no-explicit-any */
import { server } from '~/_builder/server-builder.ts';
import { withAck } from '~/ack/with.ts';
import { scope } from '~/channel/channel.ts';
import { withChannels } from '~/channel/with.ts';
import { withDedup } from '~/dedup/with.ts';
import { error } from '~/errors/errors.ts';
import { withErrors } from '~/errors/with.ts';
import { event } from '~/event.ts';
import { withHeartbeat } from '~/heartbeat/with.ts';
import { withHibernation } from '~/hibernation/with.ts';
import { withIntercept } from '~/intercept/with.ts';
import { withLifecycle } from '~/lifecycle/with.ts';
import { withNamespaces } from '~/namespace/with.ts';
import { withReplayCustom } from '~/replay/custom/with.ts';
import { withReplay } from '~/replay/with.ts';
import { withRequests } from '~/request/with.ts';
import { withScheduled } from '~/scheduled/with.ts';
import { withSequence } from '~/sequence/with.ts';
import { withStreams } from '~/stream/with.ts';
import { describe, expect, it } from 'vitest';

// ─── Event contracts ────────────────────────────────────────
const message = event('message', (p: unknown) => p as { text: string; from: string });
const notification = event('notification', (p: unknown) => p as { title: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });
const typing = event('typing', (p: unknown) => p as { userId: string });
const ping = event('health-check', (p: unknown) => p as { ts: number });
const roomMessage = event('room-message', (p: unknown) => p as { text: string; from: string });
const roomSend = event('room-send', (p: unknown) => p as { text: string });
const alert = event('alert', (p: unknown) => p as { id: string; severity: string });
const dismiss = event('dismiss', (p: unknown) => p as { id: string });
const aiComplete = event('ai-complete', (p: unknown) => p as { prompt: string });
const cancel = event('cancel', (p: unknown) => p as {});

// ─── Error definitions ──────────────────────────────────────
const Forbidden = error('forbidden', (p: unknown) => p as { reason: string });
const QuotaExceeded = error('quota-exceeded', (p: unknown) => p as { limit: number });

// ─── Helpers ────────────────────────────────────────────────
function pongSchema(p: unknown) {
  return p as { ts: number; serverTs: number };
}
function chunkSchema(p: unknown) {
  return p as { token: string };
}

function findPrimitive(primitives: readonly any[], tag: string) {
  return primitives.find((p) => p.__wskit === tag);
}

function findAllPrimitives(primitives: readonly any[], tag: string) {
  return primitives.filter((p) => p.__wskit === tag);
}

function fullServer(name: string) {
  return withStreams(
    withRequests(
      withNamespaces(
        withChannels(
          withReplayCustom(
            withReplay(
              withScheduled(
                withIntercept(
                  withErrors(
                    withLifecycle(
                      withAck(
                        withHeartbeat(withSequence(withDedup(withHibernation(server(name))))),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

// ─── Tests ──────────────────────────────────────────────────

describe('Integration: full single-file server', () => {
  const base = fullServer('chat')
    .ack()
    .heartbeat({ timeout: 60_000 })
    .sequence({ persist: true })
    .dedup()
    .hibernation()
    .errors(Forbidden, QuotaExceeded)
    .outgoing(message)
    .outgoing(notification)
    .intercept(async (_ctx, _msg) => {})
    .incoming(sendMessage, async (ctx, payload) => {
      ctx.broadcast('message', { text: payload.text, from: ctx.id });
      ctx.ack();
    })
    .incoming(typing, async () => {})
    .intercept('send-message', async (_ctx, _payload) => {})
    .request(ping, pongSchema, async (ctx, payload) => {
      ctx.respond({ ts: payload.ts, serverTs: Date.now() });
    })
    .scheduled('cleanup', (t) => t.every(60_000).run(async () => {}))
    .scheduled('expire-hold', (t) =>
      t.data((p: unknown) => p as { orderId: string }).run(async (_ctx, data) => void data.orderId),
    )
    .replay((r) => r.exclude('typing').retention({ maxAgeMs: 3_600_000 }).durability('strict'));

  const aiStream = base.stream(aiComplete, (s) =>
    s
      .chunk(chunkSchema)
      .nudge(cancel)
      .generate(async function* (_ctx, payload) {
        yield { token: payload.prompt };
      }),
  );

  const def = base
    .use(
      base.channel(scope('rooms', /^room-.+$/), (ch) =>
        ch
          .outgoing(roomMessage)
          .incoming(roomSend, async (ctx, payload) => {
            ctx.send('room-message', { text: payload.text, from: 'system' });
            ctx.send('message', { text: payload.text, from: 'system' });
          })
          .onBeforeSubscribe(async () => {})
          .onSubscribe(async () => {})
          .onUnsubscribe(async () => {}),
      ),
    )
    .use(
      base.namespace('notifications', (ns) =>
        ns.outgoing(alert).incoming(dismiss, async (ctx, payload) => {
          ctx.send('alert', { id: payload.id, severity: 'low' });
        }),
      ),
    )
    .use(aiStream)
    .onUpgrade(async () => ({ meta: { userId: 'test' } }))
    .onConnect(async (ctx) => {
      ctx.send('notification', { title: 'Welcome' });
    })
    .onDisconnect(async () => {})
    .onShutdown(async () => {})
    .onError(async () => {})
    .onBinary(async () => {})
    .onValidationError(async () => {})
    .onInit(async () => {})
    .build();

  it('produces a frozen ServerDefinition', () => {
    expect(def.__wskit).toBe('server');
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.primitives)).toBe(true);
  });

  it('contains all infrastructure primitives', () => {
    expect(findPrimitive(def.primitives, 'ack')).toBeDefined();
    expect(findPrimitive(def.primitives, 'heartbeat')).toBeDefined();
    expect(findPrimitive(def.primitives, 'sequence')).toBeDefined();
    expect(findPrimitive(def.primitives, 'dedup')).toBeDefined();
    expect(findPrimitive(def.primitives, 'hibernation')).toBeDefined();
    expect(findPrimitive(def.primitives, 'errors')).toBeDefined();
    expect(findPrimitive(def.primitives, 'replay')).toBeDefined();
  });

  it('contains all handler primitives', () => {
    const incomings = findAllPrimitives(def.primitives, 'incoming');
    expect(incomings).toHaveLength(2);
    expect(findPrimitive(def.primitives, 'request')).toBeDefined();
  });

  it('contains outgoing declarations', () => {
    const outgoings = findAllPrimitives(def.primitives, 'outgoing');
    expect(outgoings).toHaveLength(2);
  });

  it('contains intercepts', () => {
    const intercepts = findAllPrimitives(def.primitives, 'intercept');
    expect(intercepts).toHaveLength(2);
    expect(intercepts[0].mode).toBe('pre');
    expect(intercepts[1].mode).toBe('post');
  });

  it('contains scheduled tasks', () => {
    const tasks = findAllPrimitives(def.primitives, 'scheduled');
    expect(tasks).toHaveLength(2);
  });

  it('contains scopes', () => {
    expect(findPrimitive(def.primitives, 'channel')).toBeDefined();
    expect(findPrimitive(def.primitives, 'namespace')).toBeDefined();
  });

  it('contains stream + generate', () => {
    expect(findPrimitive(def.primitives, 'stream')).toBeDefined();
    expect(findPrimitive(def.primitives, 'generate')).toBeDefined();
  });

  it('contains all lifecycle hooks', () => {
    expect(findPrimitive(def.primitives, 'onUpgrade')).toBeDefined();
    expect(findPrimitive(def.primitives, 'onConnect')).toBeDefined();
    expect(findPrimitive(def.primitives, 'onDisconnect')).toBeDefined();
    expect(findPrimitive(def.primitives, 'onShutdown')).toBeDefined();
    expect(findPrimitive(def.primitives, 'onError')).toBeDefined();
    expect(findPrimitive(def.primitives, 'onBinary')).toBeDefined();
    expect(findPrimitive(def.primitives, 'onValidationError')).toBeDefined();
    expect(findPrimitive(def.primitives, 'onInit')).toBeDefined();
  });

  it('preserves declaration order', () => {
    const tags = def.primitives.map((p) => p.__wskit);
    const ackIdx = tags.indexOf('ack');
    const outgoingIdx = tags.indexOf('outgoing');
    const incomingIdx = tags.indexOf('incoming');
    const channelIdx = tags.indexOf('channel');

    expect(ackIdx).toBeLessThan(outgoingIdx);
    expect(outgoingIdx).toBeLessThan(incomingIdx);
    expect(incomingIdx).toBeLessThan(channelIdx);
  });

  it('channel has correct structure', () => {
    const ch = findPrimitive(def.primitives, 'channel');
    expect(ch.pattern.key).toBe('rooms');
    expect(ch.primitives.length).toBeGreaterThan(0);

    const chOutgoing = findPrimitive(ch.primitives, 'outgoing');
    expect(chOutgoing.event).toBe('room-message');

    const chIncoming = findPrimitive(ch.primitives, 'incoming');
    expect(chIncoming.event).toBe('room-send');

    expect(findPrimitive(ch.primitives, 'onBeforeSubscribe')).toBeDefined();
    expect(findPrimitive(ch.primitives, 'onSubscribe')).toBeDefined();
    expect(findPrimitive(ch.primitives, 'onUnsubscribe')).toBeDefined();
  });

  it('namespace has correct structure', () => {
    const ns = findPrimitive(def.primitives, 'namespace');
    expect(ns.pattern).toBe('notifications');
    expect(findPrimitive(ns.primitives, 'outgoing').event).toBe('alert');
    expect(findPrimitive(ns.primitives, 'incoming').event).toBe('dismiss');
  });

  it('stream has nudges', () => {
    const st = findPrimitive(def.primitives, 'stream');
    expect(st.event).toBe('ai-complete');
    expect(st.nudges).toHaveLength(1);
    expect(st.nudges[0].event).toBe('cancel');
  });

  it('replay has options', () => {
    const rp = findPrimitive(def.primitives, 'replay') as { options: any };
    expect(rp.options.exclude).toEqual(['typing']);
    expect(rp.options.retention).toEqual({ maxAgeMs: 3_600_000 });
    expect(rp.options.durability).toBe('strict');
  });
});

describe('Integration: multi-file composition', () => {
  const base = fullServer('chat')
    .ack()
    .heartbeat({ timeout: 60_000 })
    .outgoing(message)
    .outgoing(notification);

  it('group inlines correctly', () => {
    const def = base
      .use(
        base.group((g) =>
          g
            .incoming(sendMessage, async (ctx, payload) => {
              ctx.broadcast('message', { text: payload.text, from: ctx.id });
              ctx.ack();
            })
            .incoming(typing, async () => {}),
        ),
      )
      .build();

    const incomings = findAllPrimitives(def.primitives, 'incoming');
    expect(incomings).toHaveLength(2);
  });

  it('channel inlines correctly', () => {
    const def = base
      .use(
        base.channel(scope('rooms', /^room-.+$/), (ch) =>
          ch.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
            ctx.send('room-message', { text: 'hi', from: 'system' });
            ctx.send('message', { text: 'hi', from: 'system' });
          }),
        ),
      )
      .build();

    expect(findPrimitive(def.primitives, 'channel')).toBeDefined();
  });

  it('namespace inlines correctly', () => {
    const def = base
      .use(
        base.namespace('notifications', (ns) =>
          ns.outgoing(alert).incoming(dismiss, async (ctx) => {
            ctx.send('alert', { id: '1', severity: 'info' });
            ctx.send('message', { text: 'dismissed', from: 'system' });
          }),
        ),
      )
      .build();

    expect(findPrimitive(def.primitives, 'namespace')).toBeDefined();
  });

  it('top-level stream primitive expands when .use()-d', () => {
    const streamPrim = base.stream(aiComplete, (s) =>
      s
        .chunk(chunkSchema)
        .nudge(cancel)
        .generate(async function* (_ctx, payload) {
          yield { token: payload.prompt };
        }),
    );
    const def = base.use(streamPrim).build();

    expect(findPrimitive(def.primitives, 'stream')).toBeDefined();
    expect(findPrimitive(def.primitives, 'generate')).toBeDefined();
  });

  it('full multi-file assembly', () => {
    const s = fullServer('chat').ack().outgoing(message).outgoing(notification);
    const def = s
      .use(
        s.channel(scope('rooms', /^room-.+$/), (ch) =>
          ch
            .outgoing(roomMessage)
            .incoming(roomSend, async () => {})
            .onSubscribe(async () => {}),
        ),
      )
      .use(
        s.namespace('notifications', (ns) => ns.outgoing(alert).incoming(dismiss, async () => {})),
      )
      .use(
        s.group((g) =>
          g
            .incoming(sendMessage, async () => {})
            .request(ping, pongSchema, async (ctx, p) => {
              ctx.respond({ ts: p.ts, serverTs: 0 });
            }),
        ),
      )
      .build();

    expect(findPrimitive(def.primitives, 'channel')).toBeDefined();
    expect(findPrimitive(def.primitives, 'namespace')).toBeDefined();
    expect(findPrimitive(def.primitives, 'incoming')).toBeDefined();
    expect(findPrimitive(def.primitives, 'request')).toBeDefined();
  });
});

describe('Integration: type inference', () => {
  it('ctx.send typed against accumulated outgoing events', () => {
    fullServer('chat')
      .outgoing(message)
      .outgoing(notification)
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'system' });
        ctx.send('notification', { title: 'Hello' });

        // @ts-expect-error — undeclared event
        ctx.send('nope', {});

        // @ts-expect-error — wrong payload shape for message
        ctx.send('message', { wrong: true });
      });
  });

  it('ctx.ack available after .ack(), absent without', () => {
    fullServer('chat')
      .ack()
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        ctx.ack();
      });

    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — ack not registered
        ctx.ack();
      });
  });

  it('ctx.ack NOT available in channel scope (top-level only)', () => {
    fullServer('chat')
      .ack()
      .outgoing(message)
      .channel('lobby', (ch) =>
        ch.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
          // @ts-expect-error — ack is top-level only, not channel scope
          ctx.ack();
          ctx.send('message', { text: 'hi', from: 'system' });
          ctx.send('room-message', { text: 'hi', from: 'system' });
        }),
      );
  });

  it('channel scope has parent + local outgoing', () => {
    fullServer('chat')
      .outgoing(message)
      .channel('lobby', (ch) =>
        ch.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
          ctx.send('message', { text: 'hi', from: 'x' });
          ctx.send('room-message', { text: 'hi', from: 'x' });
        }),
      );
  });

  it('channel scope without parent outgoing only gets local', () => {
    fullServer('chat').channel('lobby', (ch) =>
      ch.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
        ctx.send('room-message', { text: 'hi', from: 'x' });

        // @ts-expect-error — message not declared in parent or local
        ctx.send('message', { text: 'hi', from: 'x' });
      }),
    );
  });

  it('namespace scope has parent + local outgoing', () => {
    fullServer('chat')
      .outgoing(message)
      .namespace('notifications', (ns) =>
        ns.outgoing(alert).incoming(dismiss, async (ctx) => {
          ctx.send('message', { text: 'hi', from: 'x' });
          ctx.send('alert', { id: '1', severity: 'high' });
        }),
      );
  });

  it('handler payload typed from event schema', () => {
    fullServer('chat')
      .outgoing(message)
      .incoming(sendMessage, async (_ctx, payload) => {
        const text: string = payload.text;
        void text;

        // @ts-expect-error — nonexistent field
        payload.nonexistent;
      });
  });

  it('.request() handler payload typed from event schema', () => {
    fullServer('chat').request(ping, pongSchema, async (ctx, payload) => {
      const ts: number = payload.ts;
      void ts;

      // @ts-expect-error — nonexistent field
      payload.nonexistent;

      ctx.respond({ ts: payload.ts, serverTs: 0 });
    });
  });

  it('group inherits parent state', () => {
    const base = fullServer('chat').ack().outgoing(message).outgoing(notification);

    base.group((g) =>
      g.outgoing(alert).incoming(sendMessage, async (ctx) => {
        ctx.ack();
        ctx.send('message', { text: 'hi', from: 'x' });
        ctx.send('notification', { title: 'Hello' });
        ctx.send('alert', { id: '1', severity: 'low' });
      }),
    );
  });
});

describe('Integration: duplicate detection', () => {
  it('rejects duplicate ack', () => {
    expect(() => fullServer('chat').ack().ack().build()).toThrow(/Duplicate/);
  });

  it('rejects duplicate incoming for same event', () => {
    expect(() =>
      fullServer('chat')
        .incoming(sendMessage, async () => {})
        .incoming(sendMessage, async () => {})
        .build(),
    ).toThrow(/Duplicate/);
  });

  it('allows different incoming events', () => {
    expect(() =>
      fullServer('chat')
        .incoming(sendMessage, async () => {})
        .incoming(typing, async () => {})
        .build(),
    ).not.toThrow();
  });

  it('rejects duplicate channel scope', () => {
    const s = fullServer('chat');
    expect(() =>
      s
        .use(s.channel('lobby', (ch) => ch))
        .use(s.channel('lobby', (ch) => ch))
        .build(),
    ).toThrow(/Duplicate/);
  });

  it('rejects duplicate namespace', () => {
    const s = fullServer('chat');
    expect(() =>
      s
        .use(s.namespace('notifications', (ns) => ns))
        .use(s.namespace('notifications', (ns) => ns))
        .build(),
    ).toThrow(/Duplicate/);
  });

  it('rejects duplicate scheduled task ID', () => {
    expect(() =>
      fullServer('chat')
        .scheduled('cleanup', (t) => t.run(async () => {}))
        .scheduled('cleanup', (t) => t.run(async () => {}))
        .build(),
    ).toThrow(/Duplicate/);
  });

  it('rejects duplicate lifecycle hooks', () => {
    expect(() =>
      fullServer('chat')
        .onConnect(async () => {})
        .onConnect(async () => {})
        .build(),
    ).toThrow(/Duplicate/);
  });
});

describe('Integration: replay modes', () => {
  it('history mode with all options', () => {
    const def = fullServer('chat')
      .sequence({ persist: true })
      .dedup()
      .replay((r) =>
        r
          .exclude('typing', 'cursor')
          .retention({ maxAgeMs: 3_600_000, maxMessages: 500 })
          .durability('best-effort'),
      )
      .build();

    const rp = findPrimitive(def.primitives, 'replay') as { options: any };
    expect(rp.options.exclude).toEqual(['typing', 'cursor']);
    expect(rp.options.retention).toEqual({ maxAgeMs: 3_600_000, maxMessages: 500 });
    expect(rp.options.durability).toBe('best-effort');
  });

  it('snapshot mode with snapshotKey and reduce', () => {
    const def = fullServer('chat')
      .sequence({ persist: true })
      .dedup()
      .replay('snapshot', (r) => r.snapshotKey((ev, _p) => ev).reduce((_prev, next) => next))
      .build();

    const rp = findPrimitive(def.primitives, 'replay') as { options: any };
    expect(rp.options.type).toBe('snapshot');
    expect(typeof rp.options.snapshotKey).toBe('function');
    expect(typeof rp.options.reduce).toBe('function');
  });

  it('custom replay with hooks', () => {
    const def = fullServer('chat')
      .sequence({ persist: true })
      .dedup()
      .replayCustom((r) =>
        r
          .onBeforeSend(() => {})
          .onAfterSend(() => {})
          .onReplay(async () => {}),
      )
      .build();

    expect(findPrimitive(def.primitives, 'replayCustom')).toBeDefined();
  });
});

describe('Integration: channel intercept and request', () => {
  it('channel supports post-intercept with string event', () => {
    const s = fullServer('chat').outgoing(roomMessage);
    const ch = s.channel('room', (ch) =>
      ch
        .outgoing(roomMessage)
        .incoming(roomSend, async (ctx, payload) => {
          ctx.send('room-message', { text: payload.text, from: 'system' });
        })
        .intercept('room-send', (_ctx, payload) => {
          return payload;
        }),
    );
    const def = s.use(ch).build();
    const channel = findPrimitive(def.primitives, 'channel');
    const postIntercept = channel.primitives.find(
      (p: any) => p.__wskit === 'intercept' && p.mode === 'post',
    );
    expect(postIntercept).toBeDefined();
    expect(postIntercept.event).toBe('room-send');
  });

  it('channel supports pre-intercept', () => {
    const s = fullServer('chat');
    const ch = s.channel('room', (ch) =>
      ch
        .outgoing(roomMessage)
        .incoming(roomSend, async () => {})
        .intercept((_ctx, message) => message),
    );
    const def = s.use(ch).build();
    const channel = findPrimitive(def.primitives, 'channel');
    const preIntercept = channel.primitives.find(
      (p: any) => p.__wskit === 'intercept' && p.mode === 'pre',
    );
    expect(preIntercept).toBeDefined();
  });

  it('channel supports request', () => {
    const s = fullServer('chat');
    const ch = s.channel('room', (ch) =>
      ch.outgoing(roomMessage).request(ping, pongSchema, (ctx) => {
        ctx.respond({ ts: 0, serverTs: Date.now() });
      }),
    );
    const def = s.use(ch).build();
    const channel = findPrimitive(def.primitives, 'channel');
    const req = channel.primitives.find((p: any) => p.__wskit === 'request');
    expect(req).toBeDefined();
    expect(req.event).toBe('health-check');
  });

  it('post-intercept accepts EventContract with typed payload', () => {
    const s = fullServer('chat');
    const ch = s.channel('room', (ch) =>
      ch
        .outgoing(roomMessage)
        .incoming(roomSend, async (ctx, payload) => {
          ctx.send('room-message', { text: payload.text, from: 'system' });
        })
        .intercept(roomSend, (_ctx, payload) => {
          return { ...payload, text: payload.text.toUpperCase() };
        }),
    );
    const def = s.use(ch).build();
    const channel = findPrimitive(def.primitives, 'channel');
    const postIntercept = channel.primitives.find(
      (p: any) => p.__wskit === 'intercept' && p.mode === 'post',
    );
    expect(postIntercept).toBeDefined();
    expect(postIntercept.event).toBe('room-send');
  });

  it('top-level post-intercept accepts EventContract', () => {
    const def = fullServer('chat')
      .incoming(sendMessage, async () => {})
      .intercept(sendMessage, (_ctx, payload) => {
        return { ...payload, text: payload.text.toUpperCase() };
      })
      .build();

    const postIntercept = def.primitives.find(
      (p: any) => p.__wskit === 'intercept' && p.mode === 'post',
    );
    expect(postIntercept).toBeDefined();
  });
});
