import { bind } from '@livething/server-cloudflare';
import { inboxRetentionDefinition } from '@livething/tests-e2e-handlers/inbox-retention';

const Base = bind(inboxRetentionDefinition);

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
