import { inboxDynamicDefinition } from '@livething/tests-e2e-handlers/inbox-dynamic';
import { bindFixture } from './bind-fixture.ts';

export class InboxDynamicServer extends bindFixture(inboxDynamicDefinition) {}
