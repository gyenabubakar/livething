import { serve } from '@wskit/server-cloudflare';
import { scheduledHandler } from './handler.ts';

export const ScheduledServer = serve(scheduledHandler, { hibernation: false });
