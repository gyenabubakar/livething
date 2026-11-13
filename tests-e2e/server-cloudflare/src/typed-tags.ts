import { typedTagsDefinition } from '@livething/tests-e2e-handlers/typed-tags';
import { bindFixture } from './bind-fixture.ts';

export class TypedTagsServer extends bindFixture(typedTagsDefinition) {}
