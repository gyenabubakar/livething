import { server } from '@wskit/server-cloudflare';
import { lifecycleHooksHandler } from './handler.ts';

export const LifecycleHooksServer = server(lifecycleHooksHandler);
