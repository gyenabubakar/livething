import { bindFixture } from './bind-fixture.ts';
import { hibernationDefinition } from './hibernation/handler.ts';

export class HibernationServer extends bindFixture(hibernationDefinition) {}
