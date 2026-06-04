import { server } from '@wskit/server-cloudflare';
import { durableConfigHandler } from '@wskit/tests-e2e-handlers/durable-config';

const Base = server(durableConfigHandler);

// Adds the test-harness restart() (ctx.abort discards in-memory state while
// durable storage survives) so persistent-sequence resume is observable.
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
