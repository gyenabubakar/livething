import { sequenceDefinition } from '@livething/tests-e2e-handlers/sequence';
import { bindFixture } from './bind-fixture.ts';

const Base = bindFixture(sequenceDefinition);

/**
 * `bind()` only offers a graceful `shutdown()` that drains connections while
 * keeping in-memory state, so a reconnect hits the same live instance. To make
 * durability across a real restart observable (here: durable-sequence continuing
 * above its reserved range), this test harness adds `restart()`: `ctx.abort()`
 * discards the in-memory instance while durable storage survives, and the next
 * request re-runs `initialize()` from storage.
 */
export class SequenceServer extends Base {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ctx = ctx;
  }

  restart(): void {
    this.#ctx.abort('e2e restart');
  }
}
