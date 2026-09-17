import { bind } from '@wskit/server-cloudflare';
import { pluginsDefinition } from './plugins/handler.ts';

export class PluginsServer extends bind(pluginsDefinition) {}
