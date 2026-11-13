import { serverRequestDefinition } from '@livething/tests-e2e-handlers/server-request';
import { bindFixture } from './bind-fixture.ts';

export class ServerRequestServer extends bindFixture(serverRequestDefinition) {}
