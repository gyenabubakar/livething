import { bind } from '@wskit/server-cloudflare';
import { pluginsHandler } from './plugins/handler.ts';

export class PluginsServer extends bind(pluginsHandler) {}
