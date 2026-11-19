import {
  awarenessDefinition,
  awarenessHibernationDefinition,
} from '@livething/tests-e2e-handlers/awareness';
import { bindFixture } from './bind-fixture.ts';

export class AwarenessServer extends bindFixture(awarenessDefinition) {}

export class AwarenessHibernationServer extends bindFixture(awarenessHibernationDefinition) {}
