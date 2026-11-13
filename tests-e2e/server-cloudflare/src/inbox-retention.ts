import { inboxRetentionDefinition } from '@livething/tests-e2e-handlers/inbox-retention';
import { bindFixture } from './bind-fixture.ts';

const Base = bindFixture(inboxRetentionDefinition);

export class InboxRetentionServer extends Base {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ctx = ctx;
  }

  restart(): void {
    this.#ctx.abort('e2e restart');
  }
}
