import { server } from '@wskit/server-cloudflare';
import { lifecycleHooksHandler } from '@wskit/tests-e2e-handlers/lifecycle-hooks';

export const LifecycleHooksServer = server(lifecycleHooksHandler);
