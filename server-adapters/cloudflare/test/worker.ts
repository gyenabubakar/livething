import { DurableObject } from 'cloudflare:workers';

// Minimal Durable Object whose only job is to expose a real SQLite handle to
// the workers-pool test. The test reaches into it via runInDurableObject().
export class SqlTestDO extends DurableObject {
  get sql() {
    return this.ctx.storage.sql;
  }
}

export default {
  fetch() {
    return new Response('ok');
  },
};
