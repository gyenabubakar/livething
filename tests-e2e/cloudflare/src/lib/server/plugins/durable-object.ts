import { serve } from '@wskit/server-cloudflare';
import { pluginsHandler } from './handler.ts';

export const PluginsServer = serve(pluginsHandler);
