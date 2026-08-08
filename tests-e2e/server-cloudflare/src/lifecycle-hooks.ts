import { server } from '@wskit/server-cloudflare';
import { lifecycleHooksHandler } from '@wskit/tests-e2e-handlers/lifecycle-hooks';

export class LifecycleHooksServer extends server(lifecycleHooksHandler) {}
