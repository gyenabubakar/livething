import { serve } from '@wskit/server-cloudflare';
import { hibernationHandler } from './handler.ts';

export const HibernationServer = serve(hibernationHandler);
