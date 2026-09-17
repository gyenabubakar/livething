import { bind } from '@wskit/server-cloudflare';
import { adminDefinition } from '@wskit/tests-e2e-handlers/admin';

export class AdminServer extends bind(adminDefinition) {}
