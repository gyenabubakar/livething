import { serve } from '@wskit/server-cloudflare';
import { replayCustomCascadeHandler } from './handler.ts';

export const ReplayCustomCascadeServer = serve(replayCustomCascadeHandler);
