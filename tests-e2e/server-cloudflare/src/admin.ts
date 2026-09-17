import { bind } from '@wskit/server-cloudflare';
import { adminHandler } from '@wskit/tests-e2e-handlers/admin';

export class AdminServer extends bind(adminHandler) {}
