import { error } from '@wskit/core';
import { received, server, t } from '@wskit/server-codegen';
import { ack as _ack } from '@wskit/server-codegen/ack';
import { channel as _channel, scope } from '@wskit/server-codegen/channel';
import { dedup as _dedup } from '@wskit/server-codegen/dedup';
import { errors as _errors } from '@wskit/server-codegen/errors';
import { heartbeat as _heartbeat } from '@wskit/server-codegen/heartbeat';
import { incoming as _incoming } from '@wskit/server-codegen/incoming';
import { intercept as _intercept } from '@wskit/server-codegen/intercept';
import { namespace as _namespace } from '@wskit/server-codegen/namespace';
import { outgoing as _outgoing } from '@wskit/server-codegen/outgoing';
import { replay as _replay } from '@wskit/server-codegen/replay';
import { request as _request } from '@wskit/server-codegen/request';
import { sequence as _sequence } from '@wskit/server-codegen/sequence';
import { stream as _stream, chunks, generate, nudge, start } from '@wskit/server-codegen/stream';
import type { InferClient } from '@wskit/server-codegen';

const Forbidden = error('forbidden', (value: unknown) => value as { reason: string });
const QuotaExceeded = error('quota-exceeded', (value: unknown) => value as { limit: number });

const {
  channel,
  define,
  errors,
  incoming,
  intercept,
  namespace,
  outgoing,
  replay,
  request,
  sequence,
  stream,
  dedup,
  heartbeat,
} = server('all-primitives', {
  _ack,
  _channel,
  _dedup,
  _errors,
  _heartbeat,
  _incoming,
  _intercept,
  _namespace,
  _outgoing,
  _replay,
  _request,
  _sequence,
  _stream,
});

const askAi = stream(
  start('ask-ai', (value: unknown) => value as { prompt: string }),
  chunks(t<{ text: string; done: boolean }>()),
  nudge('cancel'),
  nudge('add-context', (value: unknown) => value as { text: string }),
);

const roomAi = stream(
  start('room-ai', (value: unknown) => value as { room: string }),
  chunks(t<{ text: string }>()),
  nudge('cancel'),
);

const allPrimitivesServer = define(
  heartbeat({ timeout: 45_000 }),
  sequence(),
  dedup(),
  errors(Forbidden, QuotaExceeded),
  replay(),
  outgoing('message', t<{ text: string; room?: string }>()),
  outgoing('alert', t<{ level: 'info' | 'warn' | 'error' }>()),
  outgoing('usage', t<{ totalTokens: number }>()),
  intercept(async (_ctx, message) => {
    return message;
  }),
  incoming(
    received('send-message', (value: unknown) => value as { text: string; room?: string }),
    async (ctx, payload) => {
      ctx.ack();
      ctx.send('message', { text: payload.text, room: payload.room });
      ctx.broadcast('alert', { level: 'warn' });
      ctx.sendReplay(
        'message',
        { text: payload.text, room: payload.room },
        { seq: 1, messageId: 'message-1' },
      );
    },
  ),
  request(
    'get-usage',
    async (ctx, payload) => {
      const totalTokens = payload.conversationId.length;
      ctx.send('usage', { totalTokens });
      ctx.ack();
      return { totalTokens };
    },
    { validator: (value: unknown) => value as { conversationId: string } },
  ),
  generate(askAi, async function* (ctx, payload) {
    const nudges = ctx.nudges(yield { text: payload.prompt, done: false });
    for (const nudgeMessage of nudges) {
      if (nudgeMessage.event === 'add-context') {
        yield { text: nudgeMessage.payload.text, done: false };
      }
    }

    yield { text: 'done', done: true };
  }),
  namespace(
    'notifications',
    outgoing('notice', t<{ id: string; text: string }>()),
    intercept(async (_ctx, message) => message),
    incoming(
      received('dismiss-notice', (value: unknown) => value as { id: string }),
      async (ctx, payload) => {
        const _name: 'notifications' = ctx.namespace.name;
        void _name;

        ctx.send('alert', { level: 'info' });
        ctx.namespace.send('notice', { id: payload.id, text: 'dismissed' });

        // @ts-expect-error scope-local events must go through ctx.namespace
        ctx.send('notice', { id: payload.id, text: 'dismissed' });

        // @ts-expect-error old flattened scope name is gone
        ctx.namespaceName;
      },
    ),
    request('get-notices', async (ctx) => {
      ctx.namespace.broadcast('notice', { id: 'n1', text: 'Welcome' });
      return {
        notices: [{ id: 'n1', text: 'Welcome' }],
      };
    }),
    generate(
      stream(
        start('notice-stream', (value: unknown) => value as { id: string }),
        chunks(t<{ id: string; text: string }>()),
      ),
      async function* (ctx, payload) {
        ctx.namespace.send('notice', { id: payload.id, text: 'opened' });
        yield { id: payload.id, text: 'opened' };
      },
    ),
  ),
  channel(
    'general',
    outgoing('announcement', t<{ text: string }>()),
    incoming(
      received('announce', (value: unknown) => value as { text: string }),
      async (ctx, payload) => {
        const _name: string = ctx.channel.name;
        void _name;

        ctx.send('message', { text: payload.text });
        ctx.channel.send('announcement', { text: payload.text });

        // @ts-expect-error scope-local channel events must go through ctx.channel
        ctx.send('announcement', { text: payload.text });

        // @ts-expect-error old flattened scope name is gone
        ctx.channelName;
      },
    ),
  ),
  channel(
    scope('rooms', /^room-/),
    replay(),
    outgoing('typing', t<{ userId: string }>()),
    outgoing('room-message', t<{ text: string }>()),
    intercept('start-typing', async (_ctx, payload: { userId: string }) => payload),
    incoming(
      received('start-typing', (value: unknown) => value as { userId: string }),
      async (ctx, payload) => {
        const _name: string = ctx.channel.name;
        void _name;

        ctx.send('message', { text: `typing:${payload.userId}` });
        ctx.channel.send('typing', { userId: payload.userId });
        ctx.channel.sendReplay(
          'typing',
          { userId: payload.userId },
          { seq: 3, messageId: 'typing-1' },
        );

        // @ts-expect-error scope-local replay must go through ctx.channel
        ctx.sendReplay('typing', { userId: payload.userId }, { seq: 3, messageId: 'typing-1' });
      },
    ),
    request('get-room-members', async (ctx) => {
      ctx.channel.broadcast('room-message', { text: 'member list' });
      return {
        members: ['u1', 'u2'],
      };
    }),
    generate(roomAi, async function* (ctx, payload) {
      ctx.channel.send('room-message', { text: payload.room });
      yield { text: payload.room };
    }),
  ),
);

export default allPrimitivesServer;

type AllPrimitivesClient = InferClient<typeof allPrimitivesServer>;

declare const AllPrimitivesClientPlaceholder: AllPrimitivesClient;

const _incomingMessage: AllPrimitivesClient['incoming']['message'] = {
  text: 'hello',
};

const _incomingAlert: AllPrimitivesClient['incoming']['alert'] = {
  level: 'warn',
};

const _requestPayload: string =
  AllPrimitivesClientPlaceholder.requests['get-usage'].payload.conversationId;
const _streamChunkDone: boolean = AllPrimitivesClientPlaceholder.streams['ask-ai'].chunks.done;
const _namespaceNoticeText: string =
  AllPrimitivesClientPlaceholder.namespaces.notifications.incoming.notice.text;
const _generalOutgoingText: string =
  AllPrimitivesClientPlaceholder.channels.general.outgoing.announce.text;
const _roomIncomingUser: string =
  AllPrimitivesClientPlaceholder.channels.rooms['room-123']!.incoming.typing.userId;
const _forbiddenReason: string = AllPrimitivesClientPlaceholder.__errors__.forbidden.reason;

void [
  _incomingMessage,
  _incomingAlert,
  _requestPayload,
  _streamChunkDone,
  _namespaceNoticeText,
  _generalOutgoingText,
  _roomIncomingUser,
  _forbiddenReason,
];

// @ts-expect-error generated client contract should reject unknown incoming events
const _missingIncoming: AllPrimitivesClient['incoming']['missing'] = {};
void _missingIncoming;
