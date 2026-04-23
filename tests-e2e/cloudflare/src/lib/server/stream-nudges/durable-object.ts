import { serve } from '@wskit/server-cloudflare';
import { streamNudgesHandler } from './handler.ts';

export const StreamNudgesServer = serve(streamNudgesHandler, { hibernation: false });
