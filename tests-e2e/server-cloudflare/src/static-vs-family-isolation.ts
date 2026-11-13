import { staticVsFamilyIsolationDefinition } from '@livething/tests-e2e-handlers/static-vs-family-isolation';
import { bindFixture } from './bind-fixture.ts';

export class StaticVsFamilyIsolationServer extends bindFixture(staticVsFamilyIsolationDefinition) {}
