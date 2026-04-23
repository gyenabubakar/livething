import { serve } from '@wskit/server-cloudflare';
import { replayHandler } from './handler.ts';

export const ReplayServer = serve(replayHandler, { hibernation: false });
