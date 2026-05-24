import { serve } from '@wskit/server-cloudflare';
import { modulesHandler } from './handler.ts';

export const PluginsServer = serve(modulesHandler);
