import { ack } from '~/ack/ack.ts';
import { channel, scope } from '~/channel/channel.ts';
import { dedup } from '~/dedup/dedup.ts';
import { defineServer } from '~/define-server.ts';
import { error } from '~/errors/errors.ts';
import { errors } from '~/errors/primitive.ts';
import { incoming } from '~/incoming/incoming.ts';
import { intercept } from '~/intercept/intercept.ts';
import { namespace } from '~/namespace/namespace.ts';
import { outgoing } from '~/outgoing/outgoing.ts';
import { received } from '~/received.ts';
import { replay } from '~/replay/replay.ts';
import { request } from '~/request/request.ts';
import { sequence } from '~/sequence/sequence.ts';
import { chunks, generate, nudge, start, stream } from '~/stream/stream.ts';
import { t } from '~/t.ts';
import type { ChannelHandlerContext } from '~/channel/channel.ts';
import type { ServerDefinition, ServerHandlerContext } from '~/define-server.ts';
import type { InterceptMessage } from '~/intercept/intercept.ts';
import type { NamespaceHandlerContext } from '~/namespace/namespace.ts';

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
    received('send-message', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      const _text: string = payload.text;
      const _id: string = ctx.id;
      const _meta: Record<string, unknown> = ctx.meta;
      const _bufferedAmount: number = ctx.bufferedAmount;
      const _latency: number | null = ctx.latency;
      const _quality: 'excellent' | 'good' | 'degraded' | 'poor' = ctx.quality;
      const _tags: readonly string[] = ctx.tags;
      ctx.tag('room:general');
      void _text;
      void _id;
      void _meta;
      void _bufferedAmount;
      void _latency;
      void _quality;
      void _tags;

      ctx.send('message', { text: payload.text });
      ctx.broadcast('alert', { level: 'info' });
      ctx.ack();

      // @ts-expect-error — top-level ctx only sees registered outgoing events
      ctx.send('unknown', {});

      // @ts-expect-error — stream-only helper
      ctx.nudges(undefined);

      // @ts-expect-error — replay() was not registered
      ctx.sendReplay('message', { text: payload.text }, { seq: 1, messageId: 'm1' });
    },
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

const receivedMessage = received('received-message', (value: unknown) => value as { text: string });

const withReceived = defineServer(
  outgoing('message', t<{ text: string }>()),
  incoming(receivedMessage, async (ctx, payload) => {
    ctx.send('message', { text: payload.text });

    // @ts-expect-error — ack() was not registered
    ctx.ack();
  }),
);
void withReceived;

// ===========================================================================
// 2. ack() is absent when ack() is not registered
// ===========================================================================

const withoutAck = defineServer(
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('ping', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      const _id: string = ctx.id;
      const _meta: Record<string, unknown> = ctx.meta;
      const _bufferedAmount: number = ctx.bufferedAmount;
      const _latency: number | null = ctx.latency;
      const _quality: 'excellent' | 'good' | 'degraded' | 'poor' = ctx.quality;
      const _tags: readonly string[] = ctx.tags;
      ctx.tag('room:general');
      void _id;
      void _meta;
      void _bufferedAmount;
      void _latency;
      void _quality;
      void _tags;

      ctx.send('message', { text: payload.text });

      // @ts-expect-error — ack() was not registered
      ctx.ack();

      // @ts-expect-error — replay() was not registered
      ctx.sendReplay('message', { text: payload.text }, { seq: 1, messageId: 'm1' });
    },
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
    received('send-with-errors', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      const _id: string = ctx.id;
      const _meta: Record<string, unknown> = ctx.meta;
      const _bufferedAmount: number = ctx.bufferedAmount;
      const _latency: number | null = ctx.latency;
      const _quality: 'excellent' | 'good' | 'degraded' | 'poor' = ctx.quality;
      const _tags: readonly string[] = ctx.tags;
      ctx.tag('room:general');
      void _id;
      void _meta;
      void _bufferedAmount;
      void _latency;
      void _quality;
      void _tags;

      ctx.send('message', { text: payload.text });
      ctx.broadcast('alert', { level: 'warn' });
      ctx.ack();
    },
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
// 4. replay() adds ctx.sendReplay() after sequence() and dedup()
// ===========================================================================

const withReplay = defineServer(
  sequence(),
  dedup(),
  replay(),
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('replay-message', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      ctx.sendReplay('message', { text: payload.text }, { seq: 1, messageId: 'm1' });

      // @ts-expect-error — top-level ctx only sees registered outgoing events
      ctx.sendReplay('unknown', {}, { seq: 1, messageId: 'm1' });
    },
  ),
  request('replay-status', async (ctx) => {
    ctx.sendReplay('message', { text: 'history' }, { seq: 2, messageId: 'm2' });
    return { ok: true };
  }),
  generate(askAiStream, async function* (ctx, payload) {
    ctx.sendReplay('message', { text: payload.prompt }, { seq: 3, messageId: 'm3' });
    yield { text: payload.prompt };
  }),
);
void withReplay;

// ===========================================================================
// 5. intercept() types pre-validation and post-validation callbacks
// ===========================================================================

const withIntercept = defineServer(
  ack(),
  outgoing('message', t<{ text: string }>()),
  intercept(
    async (
      ctx: ServerHandlerContext<{ message: { text: string } }, true>,
      message: InterceptMessage,
    ) => {
      const _id: string = ctx.id;
      const _meta: Record<string, unknown> = ctx.meta;
      const _bufferedAmount: number = ctx.bufferedAmount;
      const _latency: number | null = ctx.latency;
      const _quality: 'excellent' | 'good' | 'degraded' | 'poor' = ctx.quality;
      const _tags: readonly string[] = ctx.tags;
      ctx.tag('room:general');
      void _id;
      void _meta;
      void _bufferedAmount;
      void _latency;
      void _quality;
      void _tags;

      ctx.send('message', { text: 'seen' });
      ctx.ack();

      const _event: string = message.event;
      const _payload: unknown = message.payload;
      void [_event, _payload];

      // @ts-expect-error — pre-validation payload is unknown
      message.payload.text;

      return message;
    },
  ),
  incoming(
    received('send-intercepted', (value: unknown) => value as { text: string }),
    async (
      ctx: ServerHandlerContext<{ message: { text: string } }, true>,
      payload: { text: string },
    ) => {
      ctx.send('message', { text: payload.text });
      ctx.ack();
    },
  ),
);
void withIntercept;

const withPostIntercept = defineServer(
  ack(),
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('send-intercepted', (value: unknown) => value as { text: string }),
    async (
      ctx: ServerHandlerContext<{ message: { text: string } }, true>,
      payload: { text: string },
    ) => {
      ctx.send('message', { text: payload.text });
      ctx.ack();
    },
  ),
  intercept(
    'send-intercepted',
    async (
      ctx: ServerHandlerContext<{ message: { text: string } }, true>,
      payload: { text: string },
    ) => {
      ctx.send('message', { text: payload.text });
      ctx.ack();

      const _text: string = payload.text;
      void _text;

      // @ts-expect-error — payload is typed from the event validator
      payload.missing;

      return payload;
    },
  ),
);
void withPostIntercept;

// ===========================================================================
// 6. defineServer() only needs generate(streamDecl, fn)
// ===========================================================================

const withGenerateOnly = defineServer(
  ack(),
  outgoing('message', t<{ text: string }>()),
  outgoing('alert', t<{ level: string }>()),
  incoming(received('ping'), async () => {}),
  request('status', async () => ({ ok: true })),
  generate(stream(start('other-stream'), chunks(t<{ text: string }>())), async function* () {
    yield { text: 'hi' };
  }),
);
void withGenerateOnly;

// ===========================================================================
// 7. namespace() types nested handlers against namespace-local outgoing only
// ===========================================================================

const namespaceStream = stream(
  start('namespace-stream', (value: unknown) => value as { prompt: string }),
  chunks(t<{ text: string }>()),
  nudge('cancel'),
);

const withNamespace = defineServer(
  ack(),
  outgoing('message', t<{ text: string }>()),
  incoming(received('top-ping'), async (ctx) => {
    ctx.send('message', { text: 'top' });
    ctx.channels.members('room-1');
    ctx.channels.kick('room-1', 'muted', 'top-level moderation');

    // @ts-expect-error — top-level ctx has no namespace helper
    ctx.namespace;
  }),
  namespace(
    'notifications',
    outgoing('alert', t<{ id: string }>()),
    outgoing('dismissed', t<{ id: string }>()),
    incoming(
      received('dismiss', (value: unknown) => value as { id: string }),
      async (ctx, payload) => {
        const _name: string = ctx.namespace.name;
        void _name;
        ctx.channels.members('room-1');

        ctx.send('dismissed', { id: payload.id });
        ctx.broadcast('alert', { id: payload.id });

        // @ts-expect-error — namespace handlers do not see top-level outgoing
        ctx.send('message', { text: payload.id });

        // @ts-expect-error — replay is not available in namespace scope
        ctx.sendReplay('alert', { id: payload.id }, { seq: 1, messageId: 'm1' });

        // @ts-expect-error — ack is not available in namespace scope
        ctx.ack();
      },
    ),
    request('get-unread', async (ctx) => {
      const _name: string = ctx.namespace.name;
      void _name;

      ctx.send('alert', { id: 'a1' });
      return { ok: true };
    }),
    generate(namespaceStream, async function* (ctx, payload) {
      const _name: string = ctx.namespace.name;
      void _name;

      ctx.send('alert', { id: payload.prompt });
      const nudges = ctx.nudges(yield { text: payload.prompt });
      const _event: 'cancel' = nudges[0]!.event;
      void _event;

      // @ts-expect-error — namespace stream handlers do not see top-level outgoing
      ctx.send('message', { text: payload.prompt });

      // @ts-expect-error — replay is not available in namespace stream scope
      ctx.sendReplay('alert', { id: payload.prompt }, { seq: 1, messageId: 'm1' });

      // @ts-expect-error — ack is not available in namespace stream scope
      ctx.ack();
    }),
  ),
);
void withNamespace;

// ===========================================================================
// 8. channel() types nested handlers against channel-local outgoing only
// ===========================================================================

const channelStream = stream(
  start('channel-stream', (value: unknown) => value as { prompt: string }),
  chunks(t<{ text: string }>()),
  nudge('cancel'),
);

const withChannel = defineServer(
  ack(),
  outgoing('message', t<{ text: string }>()),
  incoming(received('top-channel-ping'), async (ctx) => {
    ctx.send('message', { text: 'top' });

    // @ts-expect-error — top-level ctx has no channel helper
    ctx.channel;
  }),
  channel(
    scope('rooms', /^room-/),
    outgoing('typing', t<{ userId: string }>()),
    outgoing('room-message', t<{ text: string }>()),
    incoming(received('start-typing'), async (ctx) => {
      const _name: string = ctx.channel.name;
      void _name;
      ctx.channels.kick('room-1', 'muted', 'slow mode');

      ctx.send('typing', { userId: 'u1' });
      ctx.broadcast('room-message', { text: 'hi' });

      // @ts-expect-error — channel handlers do not get ack() in this API shape
      ctx.ack();

      // @ts-expect-error — channel handlers do not see top-level outgoing
      ctx.send('message', { text: 'nope' });

      // @ts-expect-error — replay is not available in channel scope
      ctx.sendReplay('room-message', { text: 'history' }, { seq: 1, messageId: 'm1' });

      // @ts-expect-error — channel handlers do not get namespace helper
      ctx.namespace;
    }),
    request('room-status', async (ctx) => {
      const _name: string = ctx.channel.name;
      void _name;

      ctx.send('typing', { userId: 'u2' });

      // @ts-expect-error — channel handlers do not get ack() in this API shape
      ctx.ack();

      return { ok: true };
    }),
    generate(channelStream, async function* (ctx, payload) {
      const _name: string = ctx.channel.name;
      void _name;

      ctx.send('room-message', { text: payload.prompt });
      const nudges = ctx.nudges(yield { text: payload.prompt });
      const _event: 'cancel' = nudges[0]!.event;
      void _event;

      // @ts-expect-error — stream handlers still do not get ack()
      ctx.ack();

      // @ts-expect-error — replay is not available in channel stream scope
      ctx.sendReplay('room-message', { text: payload.prompt }, { seq: 1, messageId: 'm1' });

      // @ts-expect-error — channel scope does not see top-level outgoing
      ctx.send('message', { text: payload.prompt });

      // @ts-expect-error — channel stream handlers do not get namespace helper
      ctx.namespace;
    }),
  ),
);
void withChannel;

// ===========================================================================
// 9. channel() loses ack() when top-level ack() is not registered
// ===========================================================================

const withoutAckChannel = defineServer(
  outgoing('message', t<{ text: string }>()),
  incoming(received('top-channel-ping-without-ack'), async (ctx) => {
    ctx.send('message', { text: 'top' });

    // @ts-expect-error — ack() was not registered at the top level
    ctx.ack();
  }),
  channel(
    scope('rooms-without-ack', /^room-without-ack-/),
    outgoing('typing', t<{ userId: string }>()),
    outgoing('room-message', t<{ text: string }>()),
    incoming(received('start-typing'), async (ctx) => {
      const _name: string = ctx.channel.name;
      void _name;

      ctx.send('typing', { userId: 'u1' });
      ctx.broadcast('room-message', { text: 'hi' });

      // @ts-expect-error — ack() was not registered at the top level
      ctx.ack();
    }),
    request('room-status', async (ctx) => {
      const _name: string = ctx.channel.name;
      void _name;

      ctx.send('typing', { userId: 'u2' });

      // @ts-expect-error — ack() was not registered at the top level
      ctx.ack();

      return { ok: true };
    }),
    generate(channelStream, async function* (ctx, payload) {
      const _name: string = ctx.channel.name;
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

// ===========================================================================
// 10. channel() can use replay() with channel-local sendReplay typing
// ===========================================================================

const withChannelReplay = defineServer(
  sequence(),
  dedup(),
  channel(
    scope('replay-rooms', /^replay-room-/),
    replay(),
    outgoing('room-message', t<{ text: string }>()),
    incoming(
      received('room-replay', (value: unknown) => value as { text: string }),
      async (ctx, payload) => {
        const _name: string = ctx.channel.name;
        void _name;

        ctx.sendReplay('room-message', { text: payload.text }, { seq: 1, messageId: 'm1' });

        // @ts-expect-error — channel replay only sees channel-local outgoing
        ctx.sendReplay('message', { text: payload.text }, { seq: 1, messageId: 'm1' });
      },
    ),
    request('room-replay-status', async (ctx) => {
      ctx.sendReplay('room-message', { text: 'history' }, { seq: 2, messageId: 'm2' });
      return { ok: true };
    }),
    generate(channelStream, async function* (ctx, payload) {
      ctx.sendReplay('room-message', { text: payload.prompt }, { seq: 3, messageId: 'm3' });
      yield { text: payload.prompt };
    }),
  ),
);
void withChannelReplay;

// ===========================================================================
// 11. scoped intercept() callbacks are typed from the scoped contract
// ===========================================================================

const withNamespaceIntercept = defineServer(
  namespace(
    'notifications',
    outgoing('alert', t<{ id: string }>()),
    intercept(
      async (
        ctx: NamespaceHandlerContext<{ alert: { id: string } }>,
        message: InterceptMessage,
      ) => {
        const _name: string = ctx.namespace.name;
        const _event: string = message.event;
        void [_name, _event];

        // @ts-expect-error — namespace intercept does not see channel helpers
        ctx.channel;

        return message;
      },
    ),
    incoming(
      received('dismiss', (value: unknown) => value as { id: string }),
      async () => {},
    ),
    intercept(
      'dismiss',
      async (ctx: NamespaceHandlerContext<{ alert: { id: string } }>, payload: { id: string }) => {
        const _name: string = ctx.namespace.name;
        const _id: string = payload.id;
        void [_name, _id];

        // @ts-expect-error — payload is typed from the namespace event validator
        payload.missing;

        return payload;
      },
    ),
  ),
);
void withNamespaceIntercept;

const withChannelIntercept = defineServer(
  channel(
    scope('intercept-rooms', /^intercept-room-/),
    outgoing('message', t<{ text: string }>()),
    intercept(
      async (
        ctx: ChannelHandlerContext<{ message: { text: string } }>,
        message: InterceptMessage,
      ) => {
        const _name: string = ctx.channel.name;
        const _event: string = message.event;
        void [_name, _event];
        return message;
      },
    ),
    incoming(
      received('send-message', (value: unknown) => value as { text: string }),
      async () => {},
    ),
    intercept(
      'send-message',
      async (
        ctx: ChannelHandlerContext<{ message: { text: string } }>,
        payload: { text: string },
      ) => {
        const _name: string = ctx.channel.name;
        const _text: string = payload.text;
        void [_name, _text];
        return payload;
      },
    ),
  ),
);
void withChannelIntercept;
