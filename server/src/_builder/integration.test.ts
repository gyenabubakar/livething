/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Type-level integration tests.
 *
 * These tests verify compile-time type inference — the test passes if the
 * file compiles. @ts-expect-error directives verify that invalid code is
 * correctly rejected. Every test mimics how a real developer would use the
 * API so we catch regressions at the type boundary.
 */

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
import { describe, it } from 'vitest';
import type { InferClient } from '~/infer-client.ts';

function fullServer<TEnv extends object = Record<string, unknown>>(name: string) {
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
                        withHeartbeat(withSequence(withDedup(withHibernation(server<TEnv>(name))))),
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

// ─── Contracts (mimics a real app's shared event definitions) ─

const message = event('message', (p: unknown) => p as { text: string; from: string });
const notification = event('notification', (p: unknown) => p as { title: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });
const typing = event('typing', (p: unknown) => p as { userId: string });
const ping = event('ping', (p: unknown) => p as { ts: number });
const roomMessage = event('room-message', (p: unknown) => p as { text: string; from: string });
const roomSend = event('room-send', (p: unknown) => p as { text: string });
const alertEvent = event('alert', (p: unknown) => p as { id: string; severity: string });
const dismiss = event('dismiss', (p: unknown) => p as { id: string });
const aiComplete = event('ai-complete', (p: unknown) => p as { prompt: string });
const cancel = event('cancel', (p: unknown) => p as {});
const addContext = event('add-context', (p: unknown) => p as { hint: string });

function pongSchema(p: unknown) {
  return p as { ts: number; serverTs: number };
}
function chunkSchema(p: unknown) {
  return p as { token: string };
}

// ─── Type helpers ────────────────────────────────────────────

function assertType<_T>() {}
function assertExact<A, _B extends A>() {}

// ═══════════════════════════════════════════════════════════════
// 1. ctx.send() — outgoing event typing
// ═══════════════════════════════════════════════════════════════

describe('ctx.send() typing', () => {
  it('allows declared outgoing events with correct payload', () => {
    server('chat')
      .outgoing(message)
      .outgoing(notification)
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'system' });
        ctx.send('notification', { title: 'Hello' });
      });
  });

  it('rejects undeclared event names', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — 'nope' was never declared with .outgoing()
        ctx.send('nope', {});
      });
  });

  it('rejects wrong payload shape', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — missing required 'from' field
        ctx.send('message', { text: 'hi' });
      });
  });

  it('ctx.send returns boolean (matches runtime)', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        const ok: boolean = ctx.send('message', { text: 'hi', from: 'x' });
        assertType<boolean>();
        void ok;
      });
  });

  it('ctx.broadcast accepts BroadcastOptions', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        ctx.broadcast('message', { text: 'hi', from: 'x' }, { excludeSelf: true });
        ctx.broadcast('message', { text: 'hi', from: 'x' }, { channel: 'lobby' });
        ctx.broadcast(
          'message',
          { text: 'hi', from: 'x' },
          { excludeSelf: true, channel: 'lobby' },
        );
        ctx.broadcast('message', { text: 'hi', from: 'x' });
      });
  });

  it('ctx.broadcast rejects unknown option keys', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — 'nope' is not a valid BroadcastOptions field
        ctx.broadcast('message', { text: 'hi', from: 'x' }, { nope: true });
      });
  });

  it('order matters — outgoing declared after incoming is not visible to earlier handler', () => {
    server('chat')
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — message declared after this handler
        ctx.send('message', { text: 'hi', from: 'x' });
      })
      .outgoing(message);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. ctx.ack() — top-level only, opt-in
// ═══════════════════════════════════════════════════════════════

describe('ctx.ack() availability', () => {
  it('available after .ack() in top-level handler', () => {
    fullServer('chat')
      .ack()
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        ctx.ack();
      });
  });

  it('rejected when .ack() not registered', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — ack() not called on builder
        ctx.ack();
      });
  });

  it('NOT available inside channel scope even when registered at top level', () => {
    fullServer('chat')
      .ack()
      .outgoing(message)
      .channel('lobby', (ch) =>
        ch.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
          ctx.send('message', { text: 'hi', from: 'x' });
          ctx.send('room-message', { text: 'hi', from: 'x' });

          // @ts-expect-error — ack is top-level only
          ctx.ack();
        }),
      );
  });

  it('NOT available inside namespace scope', () => {
    fullServer('chat')
      .ack()
      .namespace('alerts', (ns) =>
        ns.outgoing(alertEvent).incoming(dismiss, async (ctx) => {
          // @ts-expect-error — ack is top-level only
          ctx.ack();
        }),
      );
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Handler payload typing
// ═══════════════════════════════════════════════════════════════

describe('handler payload typing', () => {
  it('.incoming() payload is typed from event schema', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (_ctx, payload) => {
        void (payload.text satisfies string);

        // @ts-expect-error — field does not exist on { text: string }
        payload.nonexistent;
      });
  });

  it('.request() handler has ctx.respond() and typed payload', () => {
    fullServer('chat').request(ping, pongSchema, async (ctx, payload) => {
      void (payload.ts satisfies number);

      // @ts-expect-error — field does not exist on { ts: number }
      payload.nonexistent;

      ctx.respond({ ts: 0, serverTs: 0 });
    });
  });

  it('.stream().generate() payload is typed from event schema', () => {
    fullServer('chat').stream(aiComplete, (s) =>
      s.chunk(chunkSchema).generate(async function* (_ctx, payload) {
        void (payload.prompt satisfies string);

        // @ts-expect-error — field does not exist on { prompt: string }
        payload.nonexistent;

        yield { token: 'hi' };
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Scoped ctx — channels and namespaces
// ═══════════════════════════════════════════════════════════════

describe('scoped ctx typing', () => {
  it('channel handler gets parent outgoing + local outgoing', () => {
    fullServer('chat')
      .outgoing(message)
      .channel('lobby', (ch) =>
        ch.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
          ctx.send('message', { text: 'hi', from: 'x' });
          ctx.send('room-message', { text: 'hi', from: 'x' });
        }),
      );
  });

  it('channel handler without parent outgoing only gets local', () => {
    fullServer('chat').channel('lobby', (ch) =>
      ch.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
        ctx.send('room-message', { text: 'hi', from: 'x' });

        // @ts-expect-error — message not declared in parent or local
        ctx.send('message', { text: 'hi', from: 'x' });
      }),
    );
  });

  it('namespace handler gets parent outgoing + local outgoing', () => {
    fullServer('chat')
      .outgoing(message)
      .namespace('alerts', (ns) =>
        ns.outgoing(alertEvent).incoming(dismiss, async (ctx) => {
          ctx.send('message', { text: 'hi', from: 'x' });
          ctx.send('alert', { id: '1', severity: 'low' });
        }),
      );
  });

  it('namespace handler rejects undeclared events', () => {
    fullServer('chat').namespace('alerts', (ns) =>
      ns.outgoing(alertEvent).incoming(dismiss, async (ctx) => {
        // @ts-expect-error — 'nope' not declared in parent or local
        ctx.send('nope', {});
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. ctx.meta — typed from .onUpgrade() return
// ═══════════════════════════════════════════════════════════════

describe('ctx.meta typing', () => {
  it('typed when .onUpgrade() returns typed meta object', () => {
    fullServer('chat')
      .outgoing(message)
      .onUpgrade(async (_req) => ({
        meta: { userId: 'abc', role: 'admin' as const },
      }))
      .incoming(sendMessage, async (ctx) => {
        void (ctx.meta.userId satisfies string);
        void (ctx.meta.role satisfies 'admin');

        // @ts-expect-error — 'email' not in meta
        ctx.meta.email;
      });
  });

  it('defaults to Record<string, unknown> without .onUpgrade()', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        assertExact<typeof ctx.meta, Record<string, unknown>>();
      });
  });

  it('flows into channel scope handlers', () => {
    fullServer('chat')
      .onUpgrade(async () => ({ meta: { userId: 'test' } }))
      .channel('lobby', (ch) =>
        ch.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
          void (ctx.meta.userId satisfies string);

          // @ts-expect-error — 'email' not in meta
          ctx.meta.email;
        }),
      );
  });

  it('flows into namespace scope handlers', () => {
    fullServer('chat')
      .onUpgrade(async () => ({ meta: { userId: 'test' } }))
      .namespace('alerts', (ns) =>
        ns.outgoing(alertEvent).incoming(dismiss, async (ctx) => {
          void (ctx.meta.userId satisfies string);
        }),
      );
  });

  it('flows into .onConnect() handler', () => {
    fullServer('chat')
      .outgoing(message)
      .onUpgrade(async () => ({ meta: { userId: 'test' } }))
      .onConnect(async (ctx) => {
        void (ctx.meta.userId satisfies string);
      });
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. ctx.channels — typed channel name parameters
// ═══════════════════════════════════════════════════════════════

describe('ctx.channels typing', () => {
  it('static channels restrict name to registered literals', () => {
    const s = fullServer('chat');
    s.use(s.channel('lobby', (ch) => ch.outgoing(roomMessage).incoming(roomSend, async () => {})))
      .use(s.channel('vip', (ch) => ch.incoming(roomSend, async () => {})))
      .incoming(sendMessage, async (ctx) => {
        ctx.channels.get('lobby').members();
        ctx.channels.get('vip').members();
        await ctx.channels.get('lobby').kick('banned', 'reason');

        // @ts-expect-error — 'nonexistent' is not a registered channel
        ctx.channels.get('nonexistent');
      });
  });

  it('dynamic channel (scope) requires concrete name', () => {
    const s = fullServer('chat');
    s.use(
      s.channel(scope('rooms', /^room-.+$/), (ch) =>
        ch.outgoing(roomMessage).incoming(roomSend, async () => {}),
      ),
    ).incoming(sendMessage, async (ctx) => {
      ctx.channels.get('rooms', 'room-123').members();
      ctx.channels.get('rooms', 'any-string-ok').members();
    });
  });

  it('mixed static + dynamic — both forms work, names stay disjoint', () => {
    const s = fullServer('chat');
    s.use(s.channel('lobby', (ch) => ch.incoming(roomSend, async () => {})))
      .use(s.channel(scope('rooms', /^room-.+$/), (ch) => ch.incoming(roomSend, async () => {})))
      .incoming(sendMessage, async (ctx) => {
        ctx.channels.get('lobby').members();
        ctx.channels.get('rooms', 'room-abc').members();
      });
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Stream ctx.nudges() — conditional on declarations
// ═══════════════════════════════════════════════════════════════

describe('stream ctx.nudges()', () => {
  it('ctx.nudges() exists when nudges are declared', () => {
    fullServer('chat').stream(aiComplete, (s) =>
      s
        .chunk(chunkSchema)
        .nudge(cancel)
        .generate(async function* (ctx, _payload) {
          const raw = yield { token: 'hi' };
          const msgs = ctx.nudges(raw);
          void msgs;
        }),
    );
  });

  it('ctx.nudges does NOT exist when no nudges declared', () => {
    fullServer('chat').stream(aiComplete, (s) =>
      s.chunk(chunkSchema).generate(async function* (ctx, _payload) {
        // @ts-expect-error — no nudges declared, method should not exist
        ctx.nudges;

        yield { token: 'hi' };
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Group builder inherits parent state
// ═══════════════════════════════════════════════════════════════

describe('group builder state inheritance', () => {
  it('group handler gets parent outgoing + ack', () => {
    const base = fullServer('chat').ack().outgoing(message);

    base.group((g) =>
      g.incoming(sendMessage, async (ctx) => {
        ctx.ack();
        ctx.send('message', { text: 'hi', from: 'x' });
      }),
    );
  });

  it('group can add its own outgoing events', () => {
    const base = server('chat').outgoing(message);

    base.group((g) =>
      g.outgoing(alertEvent).incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'x' });
        ctx.send('alert', { id: '1', severity: 'low' });
      }),
    );
  });

  it('typed meta flows through group', () => {
    const base = fullServer('chat')
      .outgoing(message)
      .onUpgrade(async () => ({ meta: { userId: 'abc' } }));

    base.group((g) =>
      g.incoming(sendMessage, async (ctx) => {
        void (ctx.meta.userId satisfies string);
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. InferClient — full server with every primitive type
// ═══════════════════════════════════════════════════════════════

const Forbidden = error('forbidden', (p: unknown) => p as { reason: string });
const RateLimit = error('rate-limit', (p: unknown) => p as { retryAfterMs: number });

const _fullBase = fullServer('chat')
  .ack()
  .errors(Forbidden, RateLimit)
  .outgoing(message)
  .outgoing(notification)
  .incoming(sendMessage, async () => {})
  .incoming(typing, async () => {})
  .request(ping, pongSchema, async (ctx, payload) => {
    ctx.respond({ ts: payload.ts, serverTs: Date.now() });
  });

const _fullStreamPrim = _fullBase.stream(aiComplete, (s) =>
  s
    .chunk(chunkSchema)
    .nudge(cancel)
    .nudge(addContext)
    .generate(async function* (_ctx, payload) {
      yield { token: payload.prompt };
    }),
);

const fullBuilt = _fullBase
  .use(_fullStreamPrim)
  .use(
    _fullBase.channel('lobby', (ch) => ch.outgoing(roomMessage).incoming(roomSend, async () => {})),
  )
  .use(
    _fullBase.channel(scope('rooms', /^room-.+$/), (ch) =>
      ch.outgoing(roomMessage).incoming(roomSend, async () => {}),
    ),
  )
  .use(
    _fullBase.namespace('alerts', (ns) =>
      ns.outgoing(alertEvent).incoming(dismiss, async () => {}),
    ),
  )
  .build();

type Full = InferClient<typeof fullBuilt>;

describe('InferClient: top-level events', () => {
  it('outgoing events → client incoming', () => {
    assertExact<Full['incoming']['message'], { text: string; from: string }>();
    assertExact<Full['incoming']['notification'], { title: string }>();
  });

  it('incoming events → client outgoing', () => {
    assertExact<Full['outgoing']['send-message'], { text: string }>();
    assertExact<Full['outgoing']['typing'], { userId: string }>();
  });

  it('undeclared events are not in the contract', () => {
    // @ts-expect-error — 'nope' never declared
    assertType<Full['incoming']['nope']>();
  });
});

describe('InferClient: requests', () => {
  it('request payload and response types are correct', () => {
    assertExact<Full['requests']['ping']['payload'], { ts: number }>();
    assertExact<Full['requests']['ping']['response'], { ts: number; serverTs: number }>();
  });
});

describe('InferClient: streams', () => {
  it('stream with nudges has payload, chunks, and nudges', () => {
    assertExact<Full['streams']['ai-complete']['payload'], { prompt: string }>();
    assertExact<Full['streams']['ai-complete']['chunk'], { token: string }>();
    assertExact<Full['streams']['ai-complete']['nudges']['cancel'], {}>();
    assertExact<Full['streams']['ai-complete']['nudges']['add-context'], { hint: string }>();
  });
});

describe('InferClient: stream without nudges', () => {
  const _noNudgeBase = fullServer('chat');
  const _noNudgeStream = _noNudgeBase.stream(aiComplete, (s) =>
    s.chunk(chunkSchema).generate(async function* (_ctx, payload) {
      yield { token: payload.prompt };
    }),
  );
  const noNudgeServer = _noNudgeBase.use(_noNudgeStream).build();

  type NoNudge = InferClient<typeof noNudgeServer>;

  it('stream payload and chunks are present', () => {
    assertExact<NoNudge['streams']['ai-complete']['payload'], { prompt: string }>();
    assertExact<NoNudge['streams']['ai-complete']['chunk'], { token: string }>();
  });

  it('nudges field does NOT exist on no-nudge stream', () => {
    // @ts-expect-error — no nudges declared, field should not exist
    assertType<NoNudge['streams']['ai-complete']['nudges']>();
  });
});

describe('InferClient: errors', () => {
  it('declared errors are in __errors__', () => {
    assertExact<Full['__errors__']['forbidden'], { reason: string }>();
    assertExact<Full['__errors__']['rate-limit'], { retryAfterMs: number }>();
  });

  it('validation-failed is always in __errors__', () => {
    assertType<Full['__errors__']['validation-failed']>();
  });

  it('built-in scope errors (channel-not-found, channel-not-subscribed, namespace-not-found) are always in __errors__', () => {
    assertType<Full['__errors__']['channel-not-found']>();
    assertType<Full['__errors__']['channel-not-subscribed']>();
    assertType<Full['__errors__']['namespace-not-found']>();
  });
});

describe('InferClient: channels', () => {
  it('static channel contract has incoming and outgoing', () => {
    assertExact<
      Full['channels']['lobby']['incoming'],
      { 'room-message': { text: string; from: string } }
    >();
    assertExact<Full['channels']['lobby']['outgoing'], { 'room-send': { text: string } }>();
  });

  it('dynamic channel contract is keyed by string & {}', () => {
    type RoomsContract = Full['channels'][string & {}];
    assertExact<RoomsContract['incoming'], { 'room-message': { text: string; from: string } }>();
    assertExact<RoomsContract['outgoing'], { 'room-send': { text: string } }>();
  });
});

describe('InferClient: namespaces', () => {
  it('namespace contract has incoming and outgoing', () => {
    assertExact<
      Full['namespaces']['alerts']['incoming'],
      { alert: { id: string; severity: string } }
    >();
    assertExact<Full['namespaces']['alerts']['outgoing'], { dismiss: { id: string } }>();
  });
});

describe('InferClient: server with no optional features', () => {
  const minimalServer = server('bare')
    .outgoing(message)
    .incoming(sendMessage, async () => {})
    .build();

  type Minimal = InferClient<typeof minimalServer>;

  it('has incoming and outgoing', () => {
    assertExact<Minimal['incoming']['message'], { text: string; from: string }>();
    assertExact<Minimal['outgoing']['send-message'], { text: string }>();
  });

  it('requests is empty', () => {
    assertExact<Minimal['requests'], {}>();
  });

  it('streams is empty', () => {
    assertExact<Minimal['streams'], {}>();
  });

  it('channels is empty', () => {
    assertExact<Minimal['channels'], {}>();
  });

  it('namespaces is empty', () => {
    assertExact<Minimal['namespaces'], {}>();
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Composition — callback patterns
// ═══════════════════════════════════════════════════════════════

describe('multi-file composition', () => {
  it('group handler ctx preserves parent outgoing + ack', () => {
    const base = fullServer('chat').ack().outgoing(message).outgoing(notification);

    base.group((g) =>
      g.incoming(sendMessage, async (ctx) => {
        ctx.ack();
        ctx.send('message', { text: 'hi', from: 'x' });
        ctx.send('notification', { title: 'Hello' });

        // @ts-expect-error — undeclared event
        ctx.send('nope', {});
      }),
    );
  });

  it('channel handler ctx preserves parent outgoing', () => {
    const base = fullServer('chat').outgoing(message);

    base.channel('lobby', (ch) =>
      ch.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'x' });
        ctx.send('room-message', { text: 'hi', from: 'x' });

        // @ts-expect-error — undeclared
        ctx.send('nope', {});
      }),
    );
  });

  it('namespace handler ctx preserves parent outgoing', () => {
    const base = fullServer('chat').outgoing(message);

    base.namespace('alerts', (ns) =>
      ns.outgoing(alertEvent).incoming(dismiss, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'x' });
        ctx.send('alert', { id: '1', severity: 'high' });

        // @ts-expect-error — undeclared
        ctx.send('nope', {});
      }),
    );
  });

  it('typed meta flows through group', () => {
    const base = fullServer('chat')
      .outgoing(message)
      .onUpgrade(async () => ({ meta: { userId: 'abc' } }));

    base.group((g) =>
      g.incoming(sendMessage, async (ctx) => {
        void (ctx.meta.userId satisfies string);

        // @ts-expect-error — not in meta
        ctx.meta.email;
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. InferClient with inline assembly
// ═══════════════════════════════════════════════════════════════

describe('InferClient from inline assembled server', () => {
  const _asmBase = fullServer('chat')
    .ack()
    .errors(Forbidden)
    .outgoing(message)
    .outgoing(notification);

  const assembled = _asmBase
    .use(
      _asmBase.group((g) =>
        g
          .incoming(sendMessage, async () => {})
          .incoming(typing, async () => {})
          .request(ping, pongSchema, async (ctx, p) => {
            ctx.respond({ ts: p.ts, serverTs: 0 });
          }),
      ),
    )
    .use(
      _asmBase.channel('lobby', (ch) =>
        ch.outgoing(roomMessage).incoming(roomSend, async () => {}),
      ),
    )
    .use(
      _asmBase.namespace('alerts', (ns) =>
        ns.outgoing(alertEvent).incoming(dismiss, async () => {}),
      ),
    )
    .use(
      _asmBase.stream(aiComplete, (s) =>
        s
          .chunk(chunkSchema)
          .nudge(cancel)
          .generate(async function* (_ctx, p) {
            yield { token: p.prompt };
          }),
      ),
    )
    .build();

  type Assembled = InferClient<typeof assembled>;

  it('top-level outgoing from inline declarations → client incoming', () => {
    assertExact<Assembled['incoming']['message'], { text: string; from: string }>();
    assertExact<Assembled['incoming']['notification'], { title: string }>();
  });

  it('incoming from group → client outgoing', () => {
    assertExact<Assembled['outgoing']['send-message'], { text: string }>();
    assertExact<Assembled['outgoing']['typing'], { userId: string }>();
  });

  it('request from group → client requests', () => {
    assertExact<Assembled['requests']['ping']['payload'], { ts: number }>();
    assertExact<Assembled['requests']['ping']['response'], { ts: number; serverTs: number }>();
  });

  it('stream from group → client streams', () => {
    assertExact<Assembled['streams']['ai-complete']['payload'], { prompt: string }>();
    assertExact<Assembled['streams']['ai-complete']['chunk'], { token: string }>();
    assertExact<Assembled['streams']['ai-complete']['nudges']['cancel'], {}>();
  });

  it('channel → client channels', () => {
    assertExact<
      Assembled['channels']['lobby']['incoming'],
      { 'room-message': { text: string; from: string } }
    >();
    assertExact<Assembled['channels']['lobby']['outgoing'], { 'room-send': { text: string } }>();
  });

  it('namespace → client namespaces', () => {
    assertExact<
      Assembled['namespaces']['alerts']['incoming'],
      { alert: { id: string; severity: string } }
    >();
    assertExact<Assembled['namespaces']['alerts']['outgoing'], { dismiss: { id: string } }>();
  });

  it('errors from inline .errors() → client __errors__', () => {
    assertExact<Assembled['__errors__']['forbidden'], { reason: string }>();
    assertType<Assembled['__errors__']['validation-failed']>();
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. Typed Env — server<TEnv>() threads env to ctx.env
// ═══════════════════════════════════════════════════════════════

describe('typed env via server<TEnv>()', () => {
  interface MyEnv {
    DATABASE_URL: string;
    API_KEY: string;
    WEBSOCKET_SERVER: unknown;
  }

  it('ctx.env is typed in incoming handlers', () => {
    server<MyEnv>('app')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        void (ctx.env.DATABASE_URL satisfies string);
        void (ctx.env.API_KEY satisfies string);

        // @ts-expect-error — not in env
        ctx.env.MISSING_VAR;
      })
      .build();
  });

  it('ctx.env is typed in onConnect lifecycle hook', () => {
    fullServer<MyEnv>('app').onConnect(async (ctx) => {
      void (ctx.env.DATABASE_URL satisfies string);

      // @ts-expect-error — not in env
      ctx.env.NOPE;
    });
  });

  it('ctx.env is typed in group handlers', () => {
    const base = server<MyEnv>('app').outgoing(message);

    base.group((g) =>
      g.incoming(sendMessage, async (ctx) => {
        void (ctx.env.API_KEY satisfies string);

        // @ts-expect-error — not in env
        ctx.env.MISSING;
      }),
    );
  });

  it('ctx.env is typed in channel handlers', () => {
    const base = fullServer<MyEnv>('app').outgoing(message);

    base.channel('lobby', (ch) =>
      ch.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
        void (ctx.env.DATABASE_URL satisfies string);

        // @ts-expect-error — not in env
        ctx.env.NO;
      }),
    );
  });

  it('ctx.env is typed in namespace handlers', () => {
    const base = fullServer<MyEnv>('app').outgoing(message);

    base.namespace('alerts', (ns) =>
      ns.outgoing(alertEvent).incoming(dismiss, async (ctx) => {
        void (ctx.env.API_KEY satisfies string);

        // @ts-expect-error — not in env
        ctx.env.WRONG;
      }),
    );
  });

  it('ctx.env is typed after onUpgrade', () => {
    fullServer<MyEnv>('app')
      .onUpgrade(async () => ({ meta: { userId: 'abc' } }))
      .incoming(sendMessage, async (ctx) => {
        void (ctx.env.DATABASE_URL satisfies string);
        void (ctx.meta.userId satisfies string);
      })
      .build();
  });

  it('ctx.env defaults to Record<string, unknown> without type param', () => {
    server('app')
      .incoming(sendMessage, async (ctx) => {
        void (ctx.env satisfies Record<string, unknown>);
      })
      .build();
  });
});
