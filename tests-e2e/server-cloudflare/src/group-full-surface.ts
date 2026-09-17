import { bind } from '@wskit/server-cloudflare';
import { groupFullSurfaceDefinition } from '@wskit/tests-e2e-handlers/group-full-surface';

export class GroupFullSurfaceServer extends bind(groupFullSurfaceDefinition) {}
