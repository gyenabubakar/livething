import { serve } from '@wskit/server-cloudflare';
import { typedTagsHandler } from './handler.ts';

export const TypedTagsServer = serve(typedTagsHandler);
