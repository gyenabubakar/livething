import { bind } from '@wskit/server-cloudflare';
import { lifecycleHooksDefinition } from '@wskit/tests-e2e-handlers/lifecycle-hooks';

export class LifecycleHooksServer extends bind(lifecycleHooksDefinition) {}
