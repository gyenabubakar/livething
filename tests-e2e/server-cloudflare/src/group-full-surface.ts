import { bind } from '@livething/server-cloudflare';
import { groupFullSurfaceDefinition } from '@livething/tests-e2e-handlers/group-full-surface';

export class GroupFullSurfaceServer extends bind(groupFullSurfaceDefinition) {}
