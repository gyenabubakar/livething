import { createPluginsHandler } from '@wskit/tests-e2e-handlers/plugins';
import { NodePlugin } from './plugins/node-plugin.ts';

export const pluginsHandler = createPluginsHandler(NodePlugin);
