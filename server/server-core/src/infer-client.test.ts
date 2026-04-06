import { defineServer } from '~/define-server.ts';
import { error } from '~/errors.ts';
import { ack } from '~/primitives/ack.ts';
import { errors } from '~/primitives/errors.ts';
import { incoming } from '~/primitives/incoming.ts';
import { outgoing } from '~/primitives/outgoing.ts';
import { request } from '~/primitives/request.ts';
import { chunks, generate, nudge, start, stream } from '~/primitives/stream.ts';
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
    'send-message',
    async (ctx, payload) => {
      ctx.send('message', { text: payload.text });
      ctx.ack();
    },
    { validator: (value: unknown) => value as { text: string } },
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
