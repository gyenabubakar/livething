import { bind } from '@livething/server-cloudflare';
import { lifecycleHooksDefinition } from '@livething/tests-e2e-handlers/lifecycle-hooks';

export class LifecycleHooksServer extends bind(lifecycleHooksDefinition) {}
