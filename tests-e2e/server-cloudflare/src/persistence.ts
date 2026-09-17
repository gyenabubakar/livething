import { bind } from '@wskit/server-cloudflare';
import { persistenceDefinition } from '@wskit/tests-e2e-handlers/persistence';

const Base = bind(persistenceDefinition);

/**
 * Test-only `restart()`: `ctx.abort()` discards the in-memory instance while
 * durable storage survives, so the next request re-runs `initialize()` from
 * storage. Lets e2e observe boot reconcile / orphan-row cleanup that a plain
 * reconnect (same live instance) can't trigger. See sequence/durable-object.ts.
 */
export class PersistenceServer extends Base {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ctx = ctx;
  }

  restart(): void {
    this.#ctx.abort('e2e restart');
  }
}
