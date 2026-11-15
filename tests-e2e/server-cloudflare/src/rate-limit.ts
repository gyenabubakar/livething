import { rateLimitDefinition } from '@livething/tests-e2e-handlers/rate-limit';
import { bindFixture } from './bind-fixture.ts';

export class RateLimitServer extends bindFixture(rateLimitDefinition) {}
