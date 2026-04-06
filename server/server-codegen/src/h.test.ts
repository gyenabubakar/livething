import { defineServer } from '~/define-server.ts';
import { h } from '~/h.ts';
import { heartbeat } from '~/heartbeat/heartbeat.ts';
import { incoming } from '~/incoming/incoming.ts';
import { outgoing } from '~/outgoing/outgoing.ts';
import { passive } from '~/passive/passive.ts';
import { received } from '~/received.ts';
import { t } from '~/t.ts';
import type { ServerHandlerContext } from '~/define-server.ts';
import type { Handled } from '~/h.ts';
import type { IncomingHandler } from '~/incoming/incoming.ts';

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = unknown extends T ? ([keyof T] extends [never] ? true : false) : false;

const wrapped = h(async (ctx: { userId: string }, payload: { text: string }) => {
  const _user: string = ctx.userId;
  const _text: string = payload.text;
  void [_user, _text];
});

const _tag: 'h' = wrapped.__wskit;
const _handledType: Handled<IncomingHandler<{ userId: string }, { text: string }>> = wrapped;
void [_tag, _handledType];

defineServer(
  passive(heartbeat({ timeout: 30_000 })),
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('needs-h', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      type CtxIsAny = IsAny<typeof ctx>;
      type CtxIsUnknown = IsUnknown<typeof ctx>;
      const _ctxIsNotAny: false = null as unknown as CtxIsAny;
      const _ctxIsUnknown: true = null as unknown as CtxIsUnknown;
      void _ctxIsNotAny;
      void _ctxIsUnknown;
      void payload;
    },
  ),
);

const receivedMessage = received('received-message', (value: unknown) => value as { text: string });

defineServer(
  outgoing('message', t<{ text: string }>()),
  incoming(receivedMessage, async (ctx, payload) => {
    type CtxIsAny = IsAny<typeof ctx>;
    const _ctxIsNotAny: false = null as unknown as CtxIsAny;
    void _ctxIsNotAny;

    ctx.send('message', { text: payload.text });

    // @ts-expect-error — ack() was not registered
    ctx.ack();
  }),
);

defineServer(
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('with-h', (value: unknown) => value as { text: string }),
    h(async (ctx, payload) => {
      type CtxIsAny = IsAny<typeof ctx>;
      const _ctxIsNotAny: false = null as unknown as CtxIsAny;
      void _ctxIsNotAny;

      ctx.send('message', { text: payload.text });

      // @ts-expect-error — ack() was not registered
      ctx.ack();
    }),
  ),
);

defineServer(
  passive(heartbeat({ timeout: 30_000 })),
  outgoing('message', t<{ text: string }>()),
  incoming(
    receivedMessage,
    async (ctx: ServerHandlerContext<{ message: { text: string } }>, payload) => {
      ctx.send('message', { text: payload.text });

      // @ts-expect-error — ack() was not registered
      ctx.ack();
    },
  ),
);
