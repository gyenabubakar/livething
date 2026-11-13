import { inboxGapDefinition } from '@livething/tests-e2e-handlers/inbox-gap';
import { bindFixture } from './bind-fixture.ts';

export class InboxGapServer extends bindFixture(inboxGapDefinition) {}
