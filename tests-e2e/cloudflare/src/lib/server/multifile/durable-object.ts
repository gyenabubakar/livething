import { serve } from '@wskit/server-cloudflare';
import { multifileHandler } from './handler.ts';

export const MultifileServer = serve(multifileHandler);
