import { createPluginsDefinition } from '@livething/tests-e2e-handlers/plugins';
import type { InferClient } from '@livething/server';
import { Drizzle } from './drizzle-plugin.ts';

export const pluginsDefinition = createPluginsDefinition(Drizzle);

export type PluginsClient = InferClient<typeof pluginsDefinition>;
