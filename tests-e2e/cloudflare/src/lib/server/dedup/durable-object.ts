import { serve } from '@wskit/server-cloudflare';
import { dedupHandler } from './handler.ts';

export const DedupServer = serve(dedupHandler, { hibernation: false });
