import {
  binaryDefinition,
  binaryHibernationDefinition,
} from '@livething/tests-e2e-handlers/binary';
import { bindFixture } from './bind-fixture.ts';

export class BinaryServer extends bindFixture(binaryDefinition) {}

export class BinaryHibernationServer extends bindFixture(binaryHibernationDefinition) {}
