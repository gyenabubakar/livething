export interface Platform<Env = unknown> {
  ctx: {
    blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T>;
    getWebSockets(tag?: string): WebSocket[];
    waitUntil?(promise: Promise<unknown>): void;
    storage: DurableObjectStorage;
  };
  env: Env;
}

export function createPlatform<Env>(state: DurableObjectState, env: Env): Platform<Env> {
  return {
    ctx: {
      blockConcurrencyWhile: state.blockConcurrencyWhile.bind(state),
      getWebSockets: state.getWebSockets.bind(state),
      waitUntil: state.waitUntil?.bind(state),
      storage: state.storage,
    },
    env,
  };
}
