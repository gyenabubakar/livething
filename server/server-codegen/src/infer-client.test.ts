import { ack } from '~/ack/ack.ts';
import { channel, scope } from '~/channel/channel.ts';
import { dedup } from '~/dedup/dedup.ts';
import { defineModule } from '~/define-module.ts';
import { defineServer } from '~/define-server.ts';
import { error } from '~/errors.ts';
import { errors } from '~/errors/errors.ts';
import { incoming } from '~/incoming/incoming.ts';
import { namespace } from '~/namespace/namespace.ts';
import { outgoing } from '~/outgoing/outgoing.ts';
import { received } from '~/received.ts';
import { replay } from '~/replay/replay.ts';
import { request } from '~/request/request.ts';
import { sequence } from '~/sequence/sequence.ts';
import { chunks, generate, nudge, start, stream } from '~/stream/stream.ts';
import { t } from '~/t.ts';
import type { InferClient } from '~/infer-client.ts';

const Forbidden = error('forbidden', (value: unknown) => value as { reason: string });
const QuotaExceeded = error('quota-exceeded', (value: unknown) => value as { limit: number });

const askAiStream = stream(
  start('ask-ai', (value: unknown) => value as { prompt: string; conversationId: string }),
  chunks(t<{ text: string; model: string }>()),
  nudge('cancel'),
  nudge('add-context', (value: unknown) => value as { text: string }),
);

const server = defineServer(
  ack(),
  errors(Forbidden, QuotaExceeded),
  outgoing('message', t<{ text: string }>()),
  outgoing('usage', t<{ inputTokens: number; outputTokens: number }>()),
  incoming(
    received('send-message', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      ctx.send('message', { text: payload.text });
      ctx.ack();
    },
  ),
  request(
    'get-usage',
    async () => ({
      inputTokens: 10,
      outputTokens: 20,
    }),
    { validator: (value: unknown) => value as { conversationId: string } },
  ),
  generate(askAiStream, async function* () {
    yield { text: 'hi', model: 'claude-sonnet-4-20250514' };
  }),
);

type Client = InferClient<typeof server>;

declare const client: Client;

const _incomingText: string = client.incoming.message.text;
const _incomingUsageIn: number = client.incoming.usage.inputTokens;
const _outgoingText: string = client.outgoing['send-message'].text;
const _requestPayload: string = client.requests['get-usage'].payload.conversationId;
const _requestResponse: number = client.requests['get-usage'].response.outputTokens;
const _streamPayload: string = client.streams['ask-ai'].payload.prompt;
const _streamChunk: string = client.streams['ask-ai'].chunks.model;
const _streamNudgeText: string = client.streams['ask-ai'].nudges['add-context'].text;
const _streamCancel: unknown = client.streams['ask-ai'].nudges.cancel;
const _forbidden: string = client.__errors__.forbidden.reason;
const _quota: number = client.__errors__['quota-exceeded'].limit;
const _validationEvent: string = client.__errors__['validation-failed'].event;
const _validationIssue: string = client.__errors__['validation-failed'].issues[0]!.message;
void [
  _incomingText,
  _incomingUsageIn,
  _outgoingText,
  _requestPayload,
  _requestResponse,
  _streamPayload,
  _streamChunk,
  _streamNudgeText,
  _streamCancel,
  _forbidden,
  _quota,
  _validationEvent,
  _validationIssue,
];

// @ts-expect-error — server outgoing becomes client incoming, not outgoing
client.outgoing.message;

// @ts-expect-error — request events do not appear in outgoing
client.outgoing['get-usage'];

// @ts-expect-error — stream declarations live under streams, not outgoing
client.outgoing['ask-ai'];

// @ts-expect-error — unknown error code
client.__errors__['missing-error'];

const streamWithoutNudges = defineServer(
  generate(
    stream(
      start('plain-stream', (value: unknown) => value as { topic: string }),
      chunks(t<{ text: string }>()),
    ),
    async function* () {
      yield { text: 'hello' };
    },
  ),
);

type ClientWithoutNudges = InferClient<typeof streamWithoutNudges>;

declare const noNudgeClient: ClientWithoutNudges;

const _plainPayload: string = noNudgeClient.streams['plain-stream'].payload.topic;
const _plainChunk: string = noNudgeClient.streams['plain-stream'].chunks.text;
const _builtInValidationError: string =
  noNudgeClient.__errors__['validation-failed'].issues[0]!.message;
void [_plainPayload, _plainChunk, _builtInValidationError];

// @ts-expect-error — nudges is omitted when no nudges are declared
noNudgeClient.streams['plain-stream'].nudges;

const namespacedServer = defineServer(
  namespace(
    'notifications',
    outgoing('alert', t<{ id: string; message: string }>()),
    incoming(
      received('dismiss', (value: unknown) => value as { id: string }),
      async () => {},
    ),
    request('get-unread', async () => ({
      alerts: [{ id: 'a1', message: 'hi' }],
    })),
    generate(
      stream(
        start('ask-ai', (value: unknown) => value as { prompt: string }),
        chunks(t<{ text: string }>()),
        nudge('cancel'),
      ),
      async function* () {
        yield { text: 'hi' };
      },
    ),
  ),
);

type NamespacedClient = InferClient<typeof namespacedServer>;

declare const namespacedClient: NamespacedClient;

const _namespaceIncomingMessage: string =
  namespacedClient.namespaces.notifications.incoming.alert.message;
const _namespaceOutgoingId: string = namespacedClient.namespaces.notifications.outgoing.dismiss.id;
const _namespaceRequestResponse: string =
  namespacedClient.namespaces.notifications.requests['get-unread'].response.alerts[0]!.message;
const _namespaceStreamChunk: string =
  namespacedClient.namespaces.notifications.streams['ask-ai'].chunks.text;
const _namespaceStreamNudge: unknown =
  namespacedClient.namespaces.notifications.streams['ask-ai'].nudges.cancel;
void [
  _namespaceIncomingMessage,
  _namespaceOutgoingId,
  _namespaceRequestResponse,
  _namespaceStreamChunk,
  _namespaceStreamNudge,
];

// @ts-expect-error — namespace events are not top-level incoming events
namespacedClient.incoming.alert;

const channelServer = defineServer(
  channel(
    'general',
    outgoing('message', t<{ text: string; from: string }>()),
    incoming(
      received('send-message', (value: unknown) => value as { text: string }),
      async () => {},
    ),
    request('get-history', async () => ({
      messages: [{ text: 'hi', from: 'u1' }],
    })),
  ),
  channel(
    scope('rooms', /^room-/),
    outgoing('typing', t<{ userId: string }>()),
    incoming(
      received('start-typing', (value: unknown) => value as { fast: boolean }),
      async () => {},
    ),
    generate(
      stream(
        start('ask-ai', (value: unknown) => value as { prompt: string }),
        chunks(t<{ text: string }>()),
        nudge('cancel'),
      ),
      async function* () {
        yield { text: 'hi' };
      },
    ),
  ),
);

type ChannelClient = InferClient<typeof channelServer>;

declare const channelClient: ChannelClient;

const _generalIncomingText: string = channelClient.channels.general.incoming.message.text;
const _generalOutgoingText: string = channelClient.channels.general.outgoing['send-message'].text;
const _generalRequestResponse: string =
  channelClient.channels.general.requests['get-history'].response.messages[0]!.from;
const _roomIncomingUser: string = channelClient.channels.rooms['room-123']!.incoming.typing.userId;
const _roomOutgoingFast: boolean =
  channelClient.channels.rooms['room-123']!.outgoing['start-typing'].fast;
const _roomStreamChunk: string =
  channelClient.channels.rooms['room-123']!.streams['ask-ai'].chunks.text;
const _roomStreamNudge: unknown =
  channelClient.channels.rooms['room-123']!.streams['ask-ai'].nudges.cancel;
void [
  _generalIncomingText,
  _generalOutgoingText,
  _generalRequestResponse,
  _roomIncomingUser,
  _roomOutgoingFast,
  _roomStreamChunk,
  _roomStreamNudge,
];

// @ts-expect-error — channel events are not top-level events
channelClient.incoming.message;

const passiveServer = defineServer(
  sequence(),
  dedup(),
  replay(),
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('send-message', (value: unknown) => value as { text: string }),
    async () => {},
  ),
  request('get-status', async () => ({ ok: true as const }), {
    validator: (value: unknown) => value as { roomId: string },
  }),
);

type PassiveClient = InferClient<typeof passiveServer>;

declare const passiveClient: PassiveClient;

const _passiveIncomingText: string = passiveClient.incoming.message.text;
const _passiveOutgoingText: string = passiveClient.outgoing['send-message'].text;
const _passiveRequestPayload: string = passiveClient.requests['get-status'].payload.roomId;
const _passiveRequestResponse: true = passiveClient.requests['get-status'].response.ok;
const _passiveValidationError: string =
  passiveClient.__errors__['validation-failed'].issues[0]!.message;
void [
  _passiveIncomingText,
  _passiveOutgoingText,
  _passiveRequestPayload,
  _passiveRequestResponse,
  _passiveValidationError,
];

// @ts-expect-error — passive infrastructure does not create client events
passiveClient.incoming.heartbeat;

const ModuleLimited = error('rate-limited', (value: unknown) => value as { retryAfter: number });

const Analytics = defineModule({
  id: 'acme:analytics',
  key: Symbol('acme:analytics'),
  outgoing: [outgoing('flushed', t<{ count: number }>())] as const,
  errors: errors(ModuleLimited),
  setup() {
    return () => ({
      flush() {
        return { count: 1 };
      },
    });
  },
});

const moduleServer = defineServer(
  outgoing('message', t<{ text: string }>()),
  Analytics({}),
  incoming(
    received('send-message', (value: unknown) => value as { text: string }),
    async () => {},
  ),
);

type ModuleClient = InferClient<typeof moduleServer>;

declare const moduleClient: ModuleClient;

const _moduleIncomingCount: number = moduleClient.incoming['__acme:analytics:flushed']!.count;
const _moduleOutgoingText: string = moduleClient.outgoing['send-message'].text;
const _moduleErrorRetryAfter: number =
  moduleClient.__errors__['__acme:analytics:rate-limited']!.retryAfter;
void [_moduleIncomingCount, _moduleOutgoingText, _moduleErrorRetryAfter];

// @ts-expect-error — module outgoing uses the prefixed public event name
moduleClient.incoming.flushed;
