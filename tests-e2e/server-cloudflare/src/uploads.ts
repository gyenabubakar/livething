import {
  uploadsDefinition,
  uploadsExpiryDefinition,
  uploadsHibernationDefinition,
} from '@livething/tests-e2e-handlers/uploads';
import { bindFixture } from './bind-fixture.ts';

export class UploadsServer extends bindFixture(uploadsDefinition) {}

export class UploadsExpiryServer extends bindFixture(uploadsExpiryDefinition) {}

export class UploadsHibernationServer extends bindFixture(uploadsHibernationDefinition) {}
