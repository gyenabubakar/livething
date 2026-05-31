import { server } from '@wskit/server-cloudflare';
import { pluginsHandler } from './handler.ts';

export const PluginsServer = server(pluginsHandler);
