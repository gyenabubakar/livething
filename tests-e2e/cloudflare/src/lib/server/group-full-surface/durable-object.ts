import { serve } from '@wskit/server-cloudflare';
import { groupFullSurfaceHandler } from './handler.ts';

export const GroupFullSurfaceServer = serve(groupFullSurfaceHandler);
