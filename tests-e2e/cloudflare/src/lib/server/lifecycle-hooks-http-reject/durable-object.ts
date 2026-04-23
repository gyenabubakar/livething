import { serve } from '@wskit/server-cloudflare';
import { rejectHttpHandler } from './handler.ts';

export const RejectHttpServer = serve(rejectHttpHandler, { hibernation: false });
