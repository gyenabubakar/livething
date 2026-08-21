import { server } from '@wskit/server-cloudflare';
import { pluginsHandler } from './plugins/handler.ts';

export class PluginsServer extends server(pluginsHandler) {}
