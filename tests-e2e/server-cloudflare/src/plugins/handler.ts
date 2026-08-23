import { createPluginsHandler } from '@wskit/tests-e2e-handlers/plugins';
import type { InferClient } from '@wskit/server';
import { Drizzle } from './drizzle-plugin.ts';

export const pluginsHandler = createPluginsHandler(Drizzle);

export type PluginsClient = InferClient<typeof pluginsHandler>;
