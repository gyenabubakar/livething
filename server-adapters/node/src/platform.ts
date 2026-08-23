import type { Server } from 'node:http';

export interface NodePlatform<Env = unknown> {
  server: Server;
  env: Env;
}

export function createPlatform<Env>(server: Server, env: Env): NodePlatform<Env> {
  return { server, env };
}
