import { Block } from '@wskit/server/errors';
import { withIntercept } from '@wskit/server/intercept';
import { withNamespaces } from '@wskit/server/namespaces';
import { withRequests } from '@wskit/server/requests';
import { withStreams } from '@wskit/server/streams';
import { NotFound } from '../errors.ts';
import { base } from '../setup.ts';
import {
  AiBlockedReply,
  AiBlockedTest,
  AiBroadcastStream,
  AiChunkSchema,
  AiResponse,
  AiSend,
  AiStreamCancelAck,
  AiStreamError,
  AiStreamPrompt,
  AiStreamWithNudges,
  BroadcastChunkSchema,
  GetModel,
  ModelResponseSchema,
  NudgePause,
  NudgeSpeedUp,
} from './events.ts';

const FAKE_RESPONSE = 'The quick brown fox jumps over the lazy dog.';
const FAKE_STREAM = 'The quick brown fox streams test tokens.';

export const aiNamespace = withIntercept(withRequests(withStreams(withNamespaces(base)))).namespace(
  'ai',
  (ns) =>
    ns
      .intercept((_ctx, message) => {
        if (message.event === 'ai-blocked-test') throw Block;
        return message;
      })
      .intercept(AiSend, (_ctx, payload) => {
        if (payload.text === 'intercept-ns-post-test') {
          return { ...payload, text: 'namespace-post-intercepted' };
        }
        return payload;
      })
      .outgoing(AiBlockedReply)
      .outgoing(AiResponse)
      .outgoing(AiStreamCancelAck)
      .incoming(AiSend, (ctx, payload) => {
        ctx.namespace.send('response', {
          text: `[Re: "${payload.text}"] ${FAKE_RESPONSE}`,
          model: 'fake-gpt-4',
        });
      })
      .request(GetModel, ModelResponseSchema, (ctx) => {
        ctx.respond({ name: 'fake-gpt-4', maxTokens: 1024 });
      })
      .stream(AiStreamPrompt, AiChunkSchema, (s) =>
        s.generate(async function* (_ctx, payload) {
          const words = `[Re: "${payload.prompt}"] ${FAKE_STREAM}`.split(' ');
          const delayMs = payload.delayMs ?? 3;
          for (const word of words) {
            yield { token: word + ' ' };
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }),
      )
      .stream(AiStreamWithNudges, AiChunkSchema, (s) =>
        s
          .nudge(NudgePause)
          .nudge(NudgeSpeedUp)
          .generate(async function* (ctx, payload) {
            let completedNaturally = false;
            try {
              const words = `[Re: "${payload.prompt}"] ${FAKE_STREAM}`.split(' ');
              let delay = payload.delayMs ?? 12;
              for (const word of words) {
                const nudges = ctx.nudges(yield { token: word + ' ' });
                if (nudges.some((n) => n.event === 'pause')) break;
                const speedUp = nudges.find((n) => n.event === 'speed-up');
                if (speedUp && 'factor' in speedUp.payload)
                  delay = Math.max(1, delay / speedUp.payload.factor);
                await new Promise((r) => setTimeout(r, delay));
              }
              completedNaturally = true;
            } finally {
              if (!completedNaturally) {
                ctx.namespace.send('stream-cancel-ack', { cancelled: true });
              }
            }
          }),
      )
      .stream(AiStreamError, AiChunkSchema, (s) =>
        s.generate(async function* () {
          yield { token: 'starting... ' };
          await new Promise((r) => setTimeout(r, 50));
          throw NotFound({ id: 'model-missing' });
        }),
      )
      .stream(AiBroadcastStream, BroadcastChunkSchema, (s) =>
        s.broadcast().generate(async function* (_ctx, payload) {
          const words = payload.prompt.split(' ');
          const delayMs = payload.delayMs ?? 3;
          for (const word of words) {
            yield { token: word + ' ' };
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }),
      )
      .incoming(AiBlockedTest, (ctx) => {
        ctx.namespace.send('ai-blocked-reply', { leaked: true });
      }),
);
