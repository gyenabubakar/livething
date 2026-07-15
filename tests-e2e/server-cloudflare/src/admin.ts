import { server } from '@wskit/server-cloudflare';
import { adminHandler } from '@wskit/tests-e2e-handlers/admin';

export const AdminServer = server(adminHandler);
