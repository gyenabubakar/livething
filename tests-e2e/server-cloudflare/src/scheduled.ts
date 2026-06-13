import { server } from '@wskit/server-cloudflare';
import { scheduledHandler } from '@wskit/tests-e2e-handlers/scheduled';

const Base = server(scheduledHandler);

/**
 * Test-only `restart()`: `ctx.abort()` discards the in-memory instance while
 * durable storage survives, so the next request re-runs `initialize()` from
 * storage. Lets e2e observe the scheduler queue surviving a restart (bootstrap
 * re-loads queued + recurring runs) that a plain reconnect can't trigger.
 * See sequence/durable-object.ts.
 */
export class ScheduledServer extends Base {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ctx = ctx;
  }

  restart(): void {
    this.#ctx.abort('e2e restart');
  }
}
