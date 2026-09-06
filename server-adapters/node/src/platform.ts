import type { Server } from 'node:http';

/**
 * Node-specific escape hatch exposed as `ctx.platform`.
 *
 * Most application code should use the portable WSKit context APIs. Use this
 * object when code needs the live Node HTTP server.
 */
export interface Platform {
  server: Server;
}

/** Creates the Node-specific value exposed through `ctx.platform`. */
export function createPlatform(server: Server): Platform {
  return { server };
}
