import { server } from '@wskit/server-cloudflare';
import { staticVsFamilyIsolationHandler } from './handler.ts';

export const StaticVsFamilyIsolationServer = server(staticVsFamilyIsolationHandler);
