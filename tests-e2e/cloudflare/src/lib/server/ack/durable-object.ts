import { serve } from '@wskit/server-cloudflare';
import { ackHandler } from './handler.ts';

export const AckServer = serve(ackHandler);
