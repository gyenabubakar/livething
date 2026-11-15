import { receiptsDefinition } from '@livething/tests-e2e-handlers/receipts';
import { bindFixture } from './bind-fixture.ts';

const Base = bindFixture(receiptsDefinition);

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
