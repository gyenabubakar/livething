import type { Server } from 'node:http';

/**
 * Node-specific escape hatch exposed as `ctx.platform`.
 *
 * Most application code should use the portable WSKit context APIs. Use this
 * object when code needs the live Node HTTP server or the adapter environment.
 */
export interface Platform<Env = unknown> {
  server: Server;
  env: Env;
}

/** Creates the Node-specific value exposed through `ctx.platform`. */
export function createPlatform<Env>(server: Server, env: Env): Platform<Env> {
  return { server, env };
}
