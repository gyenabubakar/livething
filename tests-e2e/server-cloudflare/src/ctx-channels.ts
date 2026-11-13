import { ctxChannelsDefinition } from '@livething/tests-e2e-handlers/ctx-channels';
import { bindFixture } from './bind-fixture.ts';

export class CtxChannelsServer extends bindFixture(ctxChannelsDefinition) {}
