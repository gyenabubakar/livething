import { durableConfigDefinition } from '@livething/tests-e2e-handlers/durable-config';
import { bindFixture } from './bind-fixture.ts';

const Base = bindFixture(durableConfigDefinition);

// Adds the test-harness restart() (ctx.abort discards in-memory state while
// durable storage survives) so persistent-sequence continue is observable.
export class DurableConfigServer extends Base {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ctx = ctx;
  }

  restart(): void {
    this.#ctx.abort('e2e restart');
  }
}
