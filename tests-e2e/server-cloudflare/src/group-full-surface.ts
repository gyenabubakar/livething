import { server } from '@wskit/server-cloudflare';
import { groupFullSurfaceHandler } from '@wskit/tests-e2e-handlers/group-full-surface';

export const GroupFullSurfaceServer = server(groupFullSurfaceHandler);
