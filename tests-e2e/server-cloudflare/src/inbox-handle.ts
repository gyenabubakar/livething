import { inboxHandleDefinition } from '@livething/tests-e2e-handlers/inbox-handle';
import { bindFixture } from './bind-fixture.ts';

export class InboxHandleServer extends bindFixture(inboxHandleDefinition) {}
