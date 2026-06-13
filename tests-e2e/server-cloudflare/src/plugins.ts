import { server } from '@wskit/server-cloudflare';
import { pluginsHandler } from './plugins/handler.ts';

export const PluginsServer = server(pluginsHandler);
