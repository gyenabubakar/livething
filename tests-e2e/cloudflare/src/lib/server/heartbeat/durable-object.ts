import { serve } from '@wskit/server-cloudflare';
import { heartbeatHandler } from './handler.ts';

export const HeartbeatServer = serve(heartbeatHandler, { hibernation: false });
