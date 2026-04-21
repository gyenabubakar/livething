import { serve } from '@wskit/server-cloudflare';
import { interceptHandler } from './handler.ts';

export const InterceptServer = serve(interceptHandler, { hibernation: false });
