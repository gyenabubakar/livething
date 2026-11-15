import { inboxDefinition } from '@livething/tests-e2e-handlers/inbox';
import { bindFixture } from './bind-fixture.ts';

export class InboxServer extends bindFixture(inboxDefinition) {}
