import { serve } from '@wskit/server-cloudflare';
import { requestHandler } from './handler.ts';

export const RequestServer = serve(requestHandler, { hibernation: false });
