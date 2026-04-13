import '@wskit/server/namespaces';
import '@wskit/server/requests';
import '@wskit/server/streams';

import { NotFound } from '../errors.ts';
import { base } from '../setup.ts';
import {
  AiChunkSchema,
  AiResponse,
  AiSend,
  AiStreamError,
  AiStreamPrompt,
  AiStreamWithNudges,
  GetModel,
  ModelResponseSchema,
  NudgePause,
  NudgeSpeedUp,
} from './events.ts';

const FAKE_RESPONSE = 'The quick brown fox jumps over the lazy dog.';
const FAKE_STREAM =
  'The quick brown fox jumps over the lazy dog. This is a fake AI response streamed token by token.';

export const aiNamespace = base.namespace('ai', (ns) =>
  ns
    .outgoing(AiResponse)
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
        for (const word of words) {
          yield { token: word + ' ' };
          await new Promise((r) => setTimeout(r, 50));
        }
      }),
    )
    .stream(AiStreamWithNudges, AiChunkSchema, (s) =>
      s
        .nudge(NudgePause)
        .nudge(NudgeSpeedUp)
        .generate(async function* (ctx, payload) {
          const words = `[Re: "${payload.prompt}"] ${FAKE_STREAM}`.split(' ');
          let delay = 80;
          for (const word of words) {
            const nudges = ctx.nudges(yield { token: word + ' ' });
            if (nudges.some((n) => n.event === 'pause')) break;
            const speedUp = nudges.find((n) => n.event === 'speed-up');
            if (speedUp && 'factor' in speedUp.payload)
              delay = Math.max(10, delay / speedUp.payload.factor);
            await new Promise((r) => setTimeout(r, delay));
          }
        }),
    )
    .stream(AiStreamError, AiChunkSchema, (s) =>
      s.generate(async function* () {
        yield { token: 'starting... ' };
        await new Promise((r) => setTimeout(r, 50));
        throw NotFound({ id: 'model-missing' });
      }),
    ),
);
