import { received, server, t } from '@wskit/server-codegen';
import { incoming as _incoming } from '@wskit/server-codegen/incoming';
import { outgoing as _outgoing } from '@wskit/server-codegen/outgoing';
import { request as _request } from '@wskit/server-codegen/request';
import { stream as _stream, chunks, generate, nudge, start } from '@wskit/server-codegen/stream';
import * as v from 'valibot';
import { z } from 'zod';
import type { InferClient } from '@wskit/server-codegen';

const JoinRoomSchema = z.object({
  roomId: z.string(),
  count: z.number().optional(),
});

const TypingSchema = v.object({
  roomId: v.string(),
  userId: v.string(),
});

const HistorySchema = z.object({
  roomId: z.string(),
  limit: z.number(),
});

const StreamStartSchema = v.object({
  prompt: v.string(),
});

const StreamNudgeSchema = z.object({
  text: z.string(),
});

const { define, incoming, outgoing, request, stream } = server('schema-libs', {
  _incoming,
  _outgoing,
  _request,
  _stream,
});

const aiStream = stream(
  start('ask-ai', StreamStartSchema),
  chunks(t<{ text: string; done: boolean }>()),
  nudge('add-context', StreamNudgeSchema),
);

const schemaServer = define(
  outgoing('schema-message', t<{ roomId: string; text: string }>()),
  outgoing('typing-state', t<{ roomId: string; userId: string }>()),
  incoming(received('join-room', JoinRoomSchema), async (ctx, payload) => {
    const _roomId: string = payload.roomId;
    const _count: number | undefined = payload.count;
    void [_roomId, _count];

    ctx.send('schema-message', {
      roomId: payload.roomId,
      text: `joined ${payload.roomId}`,
    });

    // @ts-expect-error generated ctx should reject unknown outgoing events
    ctx.send('missing-event', {});
  }),
  incoming(received('start-typing', TypingSchema), async (ctx, payload) => {
    const _userId: string = payload.userId;
    void _userId;

    ctx.broadcast('typing-state', {
      roomId: payload.roomId,
      userId: payload.userId,
    });
  }),
  request(
    'get-history',
    async (_ctx, payload) => {
      const _limit: number = payload.limit;
      void _limit;

      return {
        roomId: payload.roomId,
        messages: [{ text: 'hello' }],
      };
    },
    { validator: HistorySchema },
  ),
  generate(aiStream, async function* (ctx, payload) {
    const _prompt: string = payload.prompt;
    void _prompt;

    const nudges = ctx.nudges(yield { text: 'start', done: false });
    for (const message of nudges) {
      if (message.event === 'add-context') {
        const _text: string = message.payload.text;
        void _text;
      }
    }

    yield { text: 'done', done: true };
  }),
);

export default schemaServer;

type SchemaClient = InferClient<typeof schemaServer>;

declare const schemaClient: SchemaClient;

const _serverOutgoingAsClientIncoming: string = schemaClient.incoming['schema-message'].text;
const _serverIncomingAsClientOutgoing: string = schemaClient.outgoing['join-room'].roomId;
const _valibotOutgoingUser: string = schemaClient.outgoing['start-typing'].userId;
const _requestLimit: number = schemaClient.requests['get-history'].payload.limit;
const _requestMessage: string = schemaClient.requests['get-history'].response.messages[0]!.text;
const _streamPrompt: string = schemaClient.streams['ask-ai'].payload.prompt;
const _streamChunkDone: boolean = schemaClient.streams['ask-ai'].chunks.done;
const _streamNudgeText: string = schemaClient.streams['ask-ai'].nudges['add-context'].text;

void [
  _serverOutgoingAsClientIncoming,
  _serverIncomingAsClientOutgoing,
  _valibotOutgoingUser,
  _requestLimit,
  _requestMessage,
  _streamPrompt,
  _streamChunkDone,
  _streamNudgeText,
];

// @ts-expect-error client contract should reject unknown incoming events
const _missingIncoming: SchemaClient['incoming']['missing'] = {};
void _missingIncoming;
