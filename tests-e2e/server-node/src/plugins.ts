import { createPluginsDefinition } from '@livething/tests-e2e-handlers/plugins';
import { NodePlugin } from './plugins/node-plugin.ts';

export const pluginsDefinition = createPluginsDefinition(NodePlugin);
