export { WebSocketServer } from './lib/server/durable-object.ts';

interface Env {
  WEBSOCKET_SERVER: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const id = env.WEBSOCKET_SERVER.idFromName('default');
      const stub = env.WEBSOCKET_SERVER.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
