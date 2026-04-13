import { serve } from '@wskit/server-cloudflare';
import { replayCustomHandler } from './handler.ts';

export const ReplayCustomServer = serve(replayCustomHandler);
