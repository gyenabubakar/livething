import { define, emits, t } from '@wskit/server';
import { requireUsername } from '@wskit/tests-e2e-handlers/_shared/upgrade';
import type { InferClient } from '@wskit/server';

/**
 * A hibernation-enabled server that reports every heartbeat hook it sees.
 *
 * Under hibernation the Workers runtime answers a client's `ping` with `pong`
 * itself, so that frame never reaches the Durable Object and `onPing` must
 * never fire. Only `ping` is auto-answered, so `onPong` must still fire — this
 * handler lets a test prove both over the real wire.
 */
const base = define({
  hibernation: { enabled: true },
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      'ping-seen': t<{ connectionId: string }>(),
      'pong-seen': t<{ connectionId: string }>(),
    }),
  ],
});

base.onPing((ctx) => {
  ctx.send('ping-seen', { connectionId: ctx.connection.id });
});

base.onPong((ctx) => {
  ctx.send('pong-seen', { connectionId: ctx.connection.id });
});

export const heartbeatHibernationHandler = base.assemble({ handlers: [] });

export type HeartbeatHibernationClient = InferClient<typeof heartbeatHibernationHandler>;
