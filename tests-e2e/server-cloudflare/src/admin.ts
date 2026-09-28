import { bind } from '@livething/server-cloudflare';
import { adminDefinition } from '@livething/tests-e2e-handlers/admin';

export class AdminServer extends bind(adminDefinition) {}
