import { serve } from '@wskit/server-cloudflare';
import { streamBasicHandler } from './handler.ts';

export const StreamBasicServer = serve(streamBasicHandler, { hibernation: false });
