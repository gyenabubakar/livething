import { defineServer } from '~/define-server.ts';
import { ack } from '~/primitives/ack.ts';
import { incoming } from '~/primitives/incoming.ts';
import { outgoing } from '~/primitives/outgoing.ts';
import { request } from '~/primitives/request.ts';
import { generate, nudge, start, stream } from '~/primitives/stream.ts';
import { t } from '~/t.ts';
import type { ServerDefinition } from '~/define-server.ts';

// ===========================================================================
// 1. Top-level outgoing() types ctx.send()/ctx.broadcast()
// ===========================================================================

const withAck = defineServer(
  ack(),
  outgoing('message', t<{ text: string }>()),
  outgoing('alert', t<{ level: string }>()),
  incoming(
    'send-message',
    async (ctx, payload) => {
      const _text: string = payload.text;
      void _text;

      ctx.send('message', { text: payload.text });
      ctx.broadcast('alert', { level: 'info' });
      ctx.ack();

      // @ts-expect-error — top-level ctx only sees registered outgoing events
      ctx.send('unknown', {});

      // @ts-expect-error — stream-only helper
      ctx.nudges(undefined);
    },
    { validator: (value: unknown) => value as { text: string } },
  ),
  request(
    'get-alert-level',
    async (ctx, payload) => {
      const _scope: string = payload.scope;
      void _scope;

      ctx.send('alert', { level: 'debug' });
      ctx.ack();

      return { ok: true };
    },
    { validator: (value: unknown) => value as { scope: string } },
  ),
  stream(
    start('ask-ai', (value: unknown) => value as { prompt: string }),
    nudge('cancel'),
    nudge('add-context', (value: unknown) => value as { text: string }),
  ),
  generate(
    'ask-ai',
    async function* (ctx, payload) {
      ctx.send('message', { text: payload.prompt });
      ctx.broadcast('alert', { level: 'stream' });

      const nudges = ctx.nudges(yield { text: payload.prompt });
      const _event: 'cancel' | 'add-context' = nudges[0]!.event;
      void _event;

      for (const n of nudges) {
        if (n.event === 'cancel') {
          const _payload: unknown = n.payload;
          void _payload;

          // @ts-expect-error — cancel carries unknown payload, not { text: string }
          n.payload.text;
        }

        if (n.event === 'add-context') {
          const _text: string = n.payload.text;
          void _text;
        }
      }

      // @ts-expect-error — streams use _streamOk, not ctx.ack()
      ctx.ack();

      // @ts-expect-error — top-level ctx only sees registered outgoing events
      ctx.send('typing', { userId: 'u1' });
    },
    { chunks: t<{ text: string }>() },
  ),
);

const _serverTag: 'server' = withAck.__wskit;
const _serverType: ServerDefinition = withAck;
void [_serverTag, _serverType];

// ===========================================================================
// 2. ack() is absent when ack() is not registered
// ===========================================================================

const withoutAck = defineServer(
  outgoing('message', t<{ text: string }>()),
  incoming(
    'ping',
    async (ctx, payload) => {
      ctx.send('message', { text: payload.text });

      // @ts-expect-error — ack() was not registered
      ctx.ack();
    },
    { validator: (value: unknown) => value as { text: string } },
  ),
);
void withoutAck;

// ===========================================================================
// 3. generate() must match a sibling stream() by event name
// ===========================================================================

defineServer(
  ack(),
  outgoing('message', t<{ text: string }>()),
  outgoing('alert', t<{ level: string }>()),
  incoming('ping', async () => {}),
  request('status', async () => ({ ok: true })),
  stream(start('ask-ai'), nudge('cancel')),
  // @ts-expect-error — generate() must target the same stream event
  generate(
    'other-stream',
    async function* () {
      yield { text: 'hi' };
    },
    { chunks: t<{ text: string }>() },
  ),
);
