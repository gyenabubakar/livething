import { serve } from '@wskit/server-cloudflare';
import { incomingHandler } from './handler.ts';

export const IncomingServer = serve(incomingHandler, { hibernation: false });
