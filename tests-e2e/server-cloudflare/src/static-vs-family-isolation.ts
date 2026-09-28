import { bind } from '@livething/server-cloudflare';
import { staticVsFamilyIsolationDefinition } from '@livething/tests-e2e-handlers/static-vs-family-isolation';

export class StaticVsFamilyIsolationServer extends bind(staticVsFamilyIsolationDefinition) {}
