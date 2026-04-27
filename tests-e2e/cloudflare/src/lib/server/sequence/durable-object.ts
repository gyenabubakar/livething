import { serve } from '@wskit/server-cloudflare';
import { sequenceHandler } from './handler.ts';

export const SequenceServer = serve(sequenceHandler);
