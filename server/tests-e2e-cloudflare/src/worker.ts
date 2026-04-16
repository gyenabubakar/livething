export { WebSocketServer } from './lib/server/durable-object.ts';
export { ReplayServer } from './lib/server-replay/durable-object.ts';
export { ReplayCustomServer } from './lib/server-replay-custom/durable-object.ts';
export { ReplaySnapshotServer } from './lib/server-replay-snapshot/durable-object.ts';
export { ModulesServer } from './lib/server-modules/durable-object.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get('room') ?? 'default';

    if (url.pathname === '/ws') {
      const id = env.WEBSOCKET_SERVER.idFromName(room);
      return env.WEBSOCKET_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/replay') {
      const id = env.REPLAY_SERVER.idFromName(room);
      return env.REPLAY_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/replay-custom') {
      const id = env.REPLAY_CUSTOM_SERVER.idFromName(room);
      return env.REPLAY_CUSTOM_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/replay-snapshot') {
      const id = env.REPLAY_SNAPSHOT_SERVER.idFromName(room);
      return env.REPLAY_SNAPSHOT_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/modules') {
      const id = env.MODULES_SERVER.idFromName(room);
      return env.MODULES_SERVER.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
