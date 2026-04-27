import { serve } from '@wskit/server-cloudflare';
import { lifecycleHooksHandler } from './handler.ts';

export const LifecycleHooksServer = serve(lifecycleHooksHandler);
