import { server } from '@wskit/server-cloudflare';
import { staticVsFamilyIsolationHandler } from '@wskit/tests-e2e-handlers/static-vs-family-isolation';

export class StaticVsFamilyIsolationServer extends server(staticVsFamilyIsolationHandler) {}
