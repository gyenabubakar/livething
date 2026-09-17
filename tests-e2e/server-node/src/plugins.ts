import { createPluginsDefinition } from '@wskit/tests-e2e-handlers/plugins';
import { NodePlugin } from './plugins/node-plugin.ts';

export const pluginsDefinition = createPluginsDefinition(NodePlugin);
