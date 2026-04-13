import '@wskit/server/namespaces';
import '@wskit/server/requests';
import '@wskit/server/streams';

import { base } from '../setup.ts';
import {
  AiChunkSchema,
  AiResponse,
  AiSend,
  AiStreamPrompt,
  GetModel,
  ModelResponseSchema,
} from './events.ts';

const FAKE_RESPONSE = 'The quick brown fox jumps over the lazy dog.';
const FAKE_STREAM =
  'The quick brown fox jumps over the lazy dog. This is a fake AI response streamed token by token.';

export const aiNamespace = base
  .namespace('ai')
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
  .extract();
