import { serve } from '@wskit/server-cloudflare';
import { multiStateHandler } from './handler.ts';

export const MultiStateServer = serve(multiStateHandler);
