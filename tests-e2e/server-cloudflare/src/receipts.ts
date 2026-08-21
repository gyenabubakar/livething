import { server } from '@wskit/server-cloudflare';
import { receiptsHandler } from '@wskit/tests-e2e-handlers/receipts';

const Base = server(receiptsHandler);

export class ReceiptsServer extends Base {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ctx = ctx;
  }

  restart(): void {
    this.#ctx.abort('e2e restart');
  }
}
