/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Type-level integration tests.
 *
 * These tests verify compile-time type inference. They have no runtime
 * assertions — the test passes if the file compiles. @ts-expect-error
 * directives verify that invalid code is correctly rejected.
 *
 */

import { server } from '~/_builder/server-builder.ts';
import { error } from '~/errors/errors.ts';
import { event } from '~/event.ts';
import { describe, it } from 'vitest';
import type { InferClient } from '~/infer-client.ts';

import '~/_builder/side-effects/ack.ts';
import '~/_builder/side-effects/errors.ts';
import '~/_builder/side-effects/requests.ts';
import '~/_builder/side-effects/channels.ts';
import '~/_builder/side-effects/namespaces.ts';
import '~/_builder/side-effects/streams.ts';
import '~/_builder/side-effects/lifecycle.ts';

// ─── Contracts ──────────────────────────────────────────────
const message = event('message', (p: unknown) => p as { text: string; from: string });
const notification = event('notification', (p: unknown) => p as { title: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });
const ping = event('ping', (p: unknown) => p as { ts: number });
const roomMessage = event('room-message', (p: unknown) => p as { text: string; from: string });
const roomSend = event('room-send', (p: unknown) => p as { text: string });
const alertEvent = event('alert', (p: unknown) => p as { id: string; severity: string });
const dismiss = event('dismiss', (p: unknown) => p as { id: string });
const aiComplete = event('ai-complete', (p: unknown) => p as { prompt: string });
const cancel = event('cancel', (p: unknown) => p as {});

function pongSchema(p: unknown) {
  return p as { ts: number; serverTs: number };
}
function chunkSchema(p: unknown) {
  return p as { token: string };
}

// ─── ctx type inference ─────────────────────────────────────

describe('ctx type inference at each scope', () => {
  it('top-level ctx has send + ack when registered', () => {
    server('chat')
      .ack()
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'x' });
        ctx.ack();
      });
  });

  it('top-level ctx rejects ack when not registered', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — ack not registered
        ctx.ack();
      });
  });

  it('top-level ctx rejects undeclared events', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — 'nope' not declared
        ctx.send('nope', {});
      });
  });

  it('top-level ctx rejects wrong payload shape', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        // @ts-expect-error — missing 'from' field
        ctx.send('message', { text: 'hi' });
      });
  });

  it('channel ctx inherits parent outgoing but not ack (top-level only)', () => {
    server('chat')
      .ack()
      .outgoing(message)
      .channel('lobby')
      .outgoing(roomMessage)
      .incoming(roomSend, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'x' });
        ctx.send('room-message', { text: 'hi', from: 'x' });

        // @ts-expect-error — ack is top-level only
        ctx.ack();
      })
      .done();
  });

  it('channel ctx rejects events not in parent or local scope', () => {
    server('chat')
      .channel('lobby')
      .outgoing(roomMessage)
      .incoming(roomSend, async (ctx) => {
        // @ts-expect-error — 'message' not declared anywhere
        ctx.send('message', { text: 'hi', from: 'x' });
      })
      .done();
  });

  it('namespace ctx inherits parent outgoing', () => {
    server('chat')
      .outgoing(message)
      .namespace('alerts')
      .outgoing(alertEvent)
      .incoming(dismiss, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'x' });
        ctx.send('alert', { id: '1', severity: 'low' });
      })
      .done();
  });

  it('namespace ctx rejects undeclared events', () => {
    server('chat')
      .namespace('alerts')
      .outgoing(alertEvent)
      .incoming(dismiss, async (ctx) => {
        // @ts-expect-error — 'nope' not declared
        ctx.send('nope', {});
      })
      .done();
  });

  it('handler payload is typed from event schema', () => {
    server('chat')
      .outgoing(message)
      .incoming(sendMessage, async (_ctx, payload) => {
        void (payload.text satisfies string);

        // @ts-expect-error — nonexistent
        payload.nope;
      });
  });

  it('.reply() payload is typed from event schema', () => {
    server('chat').reply(ping, pongSchema, async (_ctx, payload) => {
      void (payload.ts satisfies number);

      // @ts-expect-error — nonexistent
      payload.nope;

      return { ts: 0, serverTs: 0 };
    });
  });

  it('group inherits parent state for typing', () => {
    const base = server('chat').ack().outgoing(message);

    base.group().incoming(sendMessage, async (ctx) => {
      ctx.ack();
      ctx.send('message', { text: 'hi', from: 'x' });
    });
  });

  it('multiple outgoing accumulate', () => {
    server('chat')
      .outgoing(message)
      .outgoing(notification)
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi', from: 'x' });
        ctx.send('notification', { title: 'Hello' });

        // @ts-expect-error — still rejects undeclared
        ctx.send('nope', {});
      });
  });

  it('stream generator payload typed from event schema', () => {
    server('chat')
      .stream(aiComplete, chunkSchema)
      .nudge(cancel)
      .generate(async function* (_ctx, payload) {
        void (payload.prompt satisfies string);

        // @ts-expect-error — nonexistent
        payload.nope;

        yield { token: 'hi' };
      })
      .done();
  });
});

// ─── Type helpers ───────────────────────────────────────────

function assertType<_T>() {}
function assertExact<A, _B extends A>() {}

// ─── InferClient ────────────────────────────────────────────

const Forbidden = error('forbidden', (p: unknown) => p as { reason: string });
function pongResponse(p: unknown) {
  return p as { ts: number; serverTs: number };
}

const chatServer = server('chat')
  .ack()
  .errors(Forbidden)
  .outgoing(message)
  .outgoing(notification)
  .incoming(sendMessage, async () => {})
  .reply(ping, pongResponse, async (_ctx, payload) => {
    return { ts: payload.ts, serverTs: Date.now() };
  })
  .build();

type Chat = InferClient<typeof chatServer>;

describe('InferClient from builder', () => {
  it('top-level outgoing → client incoming', () => {
    assertExact<Chat['incoming']['message'], { text: string; from: string }>();
    assertExact<Chat['incoming']['notification'], { title: string }>();
  });

  it('top-level incoming → client outgoing', () => {
    assertExact<Chat['outgoing']['send-message'], { text: string }>();
  });

  it('request → client requests', () => {
    assertExact<Chat['requests']['ping']['payload'], { ts: number }>();
    assertExact<Chat['requests']['ping']['response'], { ts: number; serverTs: number }>();
  });

  it('errors → client __errors__', () => {
    assertExact<Chat['__errors__']['forbidden'], { reason: string }>();
  });

  it('validation-failed is always in __errors__', () => {
    assertType<Chat['__errors__']['validation-failed']>();
  });
});
