import {
  collaborationDefinition,
  collaborationHibernationDefinition,
  collaborationSavesDefinition,
} from '@livething/tests-e2e-handlers/collaboration';
import { bindFixture } from './bind-fixture.ts';

export class CollaborationServer extends bindFixture(collaborationDefinition) {}

export class CollaborationHibernationServer extends bindFixture(
  collaborationHibernationDefinition,
) {}

export class CollaborationSavesServer extends bindFixture(collaborationSavesDefinition) {}
