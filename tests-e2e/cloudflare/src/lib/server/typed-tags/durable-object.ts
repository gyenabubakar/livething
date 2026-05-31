import { server } from '@wskit/server-cloudflare';
import { typedTagsHandler } from './handler.ts';

export const TypedTagsServer = server(typedTagsHandler);
