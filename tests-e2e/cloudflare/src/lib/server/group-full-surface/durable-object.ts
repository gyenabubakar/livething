import { server } from '@wskit/server-cloudflare';
import { groupFullSurfaceHandler } from './handler.ts';

export const GroupFullSurfaceServer = server(groupFullSurfaceHandler);
