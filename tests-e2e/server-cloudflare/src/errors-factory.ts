import { errorsFactoryDefinition } from '@livething/tests-e2e-handlers/errors-factory';
import { bindFixture } from './bind-fixture.ts';

export class ErrorsFactoryServer extends bindFixture(errorsFactoryDefinition) {}
