import { bindFixture } from './bind-fixture.ts';
import { pluginsDefinition } from './plugins/handler.ts';

export class PluginsServer extends bindFixture(pluginsDefinition) {}
