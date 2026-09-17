import { bind } from '@wskit/server-cloudflare';
import { staticVsFamilyIsolationDefinition } from '@wskit/tests-e2e-handlers/static-vs-family-isolation';

export class StaticVsFamilyIsolationServer extends bind(staticVsFamilyIsolationDefinition) {}
