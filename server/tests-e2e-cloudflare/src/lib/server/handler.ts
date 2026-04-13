import '@wskit/server/intercept';
import '@wskit/server/requests';

import type { InferClient } from '@wskit/server';
import { aiNamespace } from './ai/namespace.ts';
import { chatChannel } from './chat/channel.ts';
import { GetTime, TimeResponseSchema } from './echo/events.ts';
import { echoHandlers } from './echo/handlers.ts';
import { scheduledHandlers } from './scheduled/handlers.ts';
import { base } from './setup.ts';

export const handler = base
  .onConnect((ctx) => {
    ctx.broadcast('user-joined', { username: ctx.meta.username });
  })

  .onDisconnect((ctx) => {
    ctx.broadcast('user-left', { username: ctx.meta.username });
  })

  .onError((_ctx, error, event) => {
    console.error(`[wskit] error in ${event}:`, error);
  })

  .intercept((_ctx, message) => {
    console.log(`[wskit] incoming: ${message.event}`);
    return message;
  })

  .request(GetTime, TimeResponseSchema, (ctx) => {
    ctx.respond({ iso: new Date().toISOString(), epoch: Date.now() });
  })

  .use(echoHandlers)
  .use(scheduledHandlers)
  .use(chatChannel)
  .use(aiNamespace)

  .build();

export type Client = InferClient<typeof handler>;
