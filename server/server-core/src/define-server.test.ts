import { defineServer } from '~/define-server.ts';
import { error } from '~/errors.ts';
import { ack } from '~/primitives/ack.ts';
import { channel, scope } from '~/primitives/channel.ts';
import { errors } from '~/primitives/errors.ts';
import { incoming } from '~/primitives/incoming.ts';
import { namespace } from '~/primitives/namespace.ts';
import { outgoing } from '~/primitives/outgoing.ts';
import { request } from '~/primitives/request.ts';
import { chunks, generate, nudge, start, stream } from '~/primitives/stream.ts';
import { t } from '~/t.ts';
import type { ServerDefinition } from '~/define-server.ts';

// ===========================================================================
// 1. Top-level outgoing() types ctx.send()/ctx.broadcast()
// ===========================================================================

const askAiStream = stream(
  start('ask-ai', (value: unknown) => value as { prompt: string }),
  chunks(t<{ text: string }>()),
  nudge('cancel'),
  nudge('add-context', (value: unknown) => value as { text: string }),
);
const Forbidden = error('forbidden', (value: unknown) => value as { reason: string });
const QuotaExceeded = error('quota-exceeded', (value: unknown) => value as { limit: number });

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
  generate(askAiStream, async function* (ctx, payload) {
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
  }),
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
// 3. errors() composes with other primitives without losing ctx typing
// ===========================================================================

const withErrors = defineServer(
  ack(),
  errors(Forbidden, QuotaExceeded),
  outgoing('message', t<{ text: string }>()),
  outgoing('alert', t<{ level: string }>()),
  incoming(
    'send-with-errors',
    async (ctx, payload) => {
      ctx.send('message', { text: payload.text });
      ctx.broadcast('alert', { level: 'warn' });
      ctx.ack();
    },
    { validator: (value: unknown) => value as { text: string } },
  ),
  request('status-with-errors', async (ctx) => {
    ctx.send('alert', { level: 'debug' });
    ctx.ack();
    return { ok: true };
  }),
  generate(askAiStream, async function* (ctx, payload) {
    ctx.send('message', { text: payload.prompt });
    const nudges = ctx.nudges(yield { text: payload.prompt });
    void nudges;

    // @ts-expect-error — streams still do not get ack()
    ctx.ack();
  }),
);
void withErrors;

// ===========================================================================
// 4. defineServer() only needs generate(streamDecl, fn)
// ===========================================================================

const withGenerateOnly = defineServer(
  ack(),
  outgoing('message', t<{ text: string }>()),
  outgoing('alert', t<{ level: string }>()),
  incoming('ping', async () => {}),
  request('status', async () => ({ ok: true })),
  generate(stream(start('other-stream'), chunks(t<{ text: string }>())), async function* () {
    yield { text: 'hi' };
  }),
);
void withGenerateOnly;

// ===========================================================================
// 5. namespace() types nested handlers against namespace-local outgoing only
// ===========================================================================

const namespaceStream = stream(
  start('namespace-stream', (value: unknown) => value as { prompt: string }),
  chunks(t<{ text: string }>()),
  nudge('cancel'),
);

const withNamespace = defineServer(
  ack(),
  outgoing('message', t<{ text: string }>()),
  incoming('top-ping', async (ctx) => {
    ctx.send('message', { text: 'top' });

    // @ts-expect-error — top-level ctx has no namespaceName
    ctx.namespaceName;
  }),
  namespace(
    'notifications',
    outgoing('alert', t<{ id: string }>()),
    outgoing('dismissed', t<{ id: string }>()),
    incoming(
      'dismiss',
      async (ctx, payload) => {
        const _name: string = ctx.namespaceName;
        void _name;

        ctx.send('dismissed', { id: payload.id });
        ctx.broadcast('alert', { id: payload.id });

        // @ts-expect-error — namespace handlers do not see top-level outgoing
        ctx.send('message', { text: payload.id });

        // @ts-expect-error — ack is not available in namespace scope
        ctx.ack();
      },
      { validator: (value: unknown) => value as { id: string } },
    ),
    request('get-unread', async (ctx) => {
      const _name: string = ctx.namespaceName;
      void _name;

      ctx.send('alert', { id: 'a1' });
      return { ok: true };
    }),
    generate(namespaceStream, async function* (ctx, payload) {
      const _name: string = ctx.namespaceName;
      void _name;

      ctx.send('alert', { id: payload.prompt });
      const nudges = ctx.nudges(yield { text: payload.prompt });
      const _event: 'cancel' = nudges[0]!.event;
      void _event;

      // @ts-expect-error — namespace stream handlers do not see top-level outgoing
      ctx.send('message', { text: payload.prompt });

      // @ts-expect-error — ack is not available in namespace stream scope
      ctx.ack();
    }),
  ),
);
void withNamespace;

// ===========================================================================
// 6. channel() types nested handlers against channel-local outgoing only
// ===========================================================================

const channelStream = stream(
  start('channel-stream', (value: unknown) => value as { prompt: string }),
  chunks(t<{ text: string }>()),
  nudge('cancel'),
);

const withChannel = defineServer(
  ack(),
  outgoing('message', t<{ text: string }>()),
  incoming('top-channel-ping', async (ctx) => {
    ctx.send('message', { text: 'top' });

    // @ts-expect-error — top-level ctx has no channelName
    ctx.channelName;
  }),
  channel(
    scope('rooms', /^room-/),
    outgoing('typing', t<{ userId: string }>()),
    outgoing('room-message', t<{ text: string }>()),
    incoming('start-typing', async (ctx) => {
      const _name: string = ctx.channelName;
      void _name;

      ctx.send('typing', { userId: 'u1' });
      ctx.broadcast('room-message', { text: 'hi' });

      // @ts-expect-error — channel handlers do not get ack() in this API shape
      ctx.ack();

      // @ts-expect-error — channel handlers do not see top-level outgoing
      ctx.send('message', { text: 'nope' });

      // @ts-expect-error — channel handlers do not get namespaceName
      ctx.namespaceName;
    }),
    request('room-status', async (ctx) => {
      const _name: string = ctx.channelName;
      void _name;

      ctx.send('typing', { userId: 'u2' });

      // @ts-expect-error — channel handlers do not get ack() in this API shape
      ctx.ack();

      return { ok: true };
    }),
    generate(channelStream, async function* (ctx, payload) {
      const _name: string = ctx.channelName;
      void _name;

      ctx.send('room-message', { text: payload.prompt });
      const nudges = ctx.nudges(yield { text: payload.prompt });
      const _event: 'cancel' = nudges[0]!.event;
      void _event;

      // @ts-expect-error — stream handlers still do not get ack()
      ctx.ack();

      // @ts-expect-error — channel scope does not see top-level outgoing
      ctx.send('message', { text: payload.prompt });

      // @ts-expect-error — channel stream handlers do not get namespaceName
      ctx.namespaceName;
    }),
  ),
);
void withChannel;

// ===========================================================================
// 7. channel() loses ack() when top-level ack() is not registered
// ===========================================================================

const withoutAckChannel = defineServer(
  outgoing('message', t<{ text: string }>()),
  incoming('top-channel-ping-without-ack', async (ctx) => {
    ctx.send('message', { text: 'top' });

    // @ts-expect-error — ack() was not registered at the top level
    ctx.ack();
  }),
  channel(
    scope('rooms-without-ack', /^room-without-ack-/),
    outgoing('typing', t<{ userId: string }>()),
    outgoing('room-message', t<{ text: string }>()),
    incoming('start-typing', async (ctx) => {
      const _name: string = ctx.channelName;
      void _name;

      ctx.send('typing', { userId: 'u1' });
      ctx.broadcast('room-message', { text: 'hi' });

      // @ts-expect-error — ack() was not registered at the top level
      ctx.ack();
    }),
    request('room-status', async (ctx) => {
      const _name: string = ctx.channelName;
      void _name;

      ctx.send('typing', { userId: 'u2' });

      // @ts-expect-error — ack() was not registered at the top level
      ctx.ack();

      return { ok: true };
    }),
    generate(channelStream, async function* (ctx, payload) {
      const _name: string = ctx.channelName;
      void _name;

      ctx.send('room-message', { text: payload.prompt });
      const nudges = ctx.nudges(yield { text: payload.prompt });
      const _event: 'cancel' = nudges[0]!.event;
      void _event;

      // @ts-expect-error — stream handlers still do not get ack()
      ctx.ack();
    }),
  ),
);
void withoutAckChannel;
