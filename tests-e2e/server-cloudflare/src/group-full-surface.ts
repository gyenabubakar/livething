import { bind } from '@wskit/server-cloudflare';
import { groupFullSurfaceHandler } from '@wskit/tests-e2e-handlers/group-full-surface';

export class GroupFullSurfaceServer extends bind(groupFullSurfaceHandler) {}
