export { ReplayServer } from './lib/server/replay-history/durable-object.ts';
export { ReplayCustomServer } from './lib/server/replay-custom/durable-object.ts';
export { ReplaySnapshotServer } from './lib/server/replay-snapshot/durable-object.ts';
export { ModulesServer } from './lib/server/modules/durable-object.ts';
export { RejectHttpServer } from './lib/server/lifecycle-hooks-http-reject/durable-object.ts';
export { AckServer } from './lib/server/ack/durable-object.ts';
export { BinaryServer } from './lib/server/binary/durable-object.ts';
export { IncomingServer } from './lib/server/incoming/durable-object.ts';
export { RequestServer } from './lib/server/request/durable-object.ts';
export { StreamBasicServer } from './lib/server/stream-basic/durable-object.ts';
export { StreamNudgesServer } from './lib/server/stream-nudges/durable-object.ts';
export { StreamBroadcastServer } from './lib/server/stream-broadcast/durable-object.ts';
export { ChannelStaticServer } from './lib/server/channel-static/durable-object.ts';
export { ChannelDynamicServer } from './lib/server/channel-dynamic/durable-object.ts';
export { ChannelScopeIsolationServer } from './lib/server/channel-scope-isolation/durable-object.ts';
export { ChannelKeyCollisionServer } from './lib/server/channel-key-collision/durable-object.ts';
export { LifecycleHooksServer } from './lib/server/lifecycle-hooks/durable-object.ts';
export { NamespaceServer } from './lib/server/namespace/durable-object.ts';
export { InterceptServer } from './lib/server/intercept/durable-object.ts';
export { SequenceServer } from './lib/server/sequence/durable-object.ts';
export { DedupServer } from './lib/server/dedup/durable-object.ts';
export { HibernationServer } from './lib/server/hibernation/durable-object.ts';
export { ScheduledServer } from './lib/server/scheduled/durable-object.ts';
export { ErrorsFactoryServer } from './lib/server/errors-factory/durable-object.ts';
export { ErrorsControlFlowServer } from './lib/server/errors-control-flow/durable-object.ts';
export { CtxSendServer } from './lib/server/ctx-send/durable-object.ts';
export { CtxChannelsServer } from './lib/server/ctx-channels/durable-object.ts';
export { CtxSqlServer } from './lib/server/ctx-sql/durable-object.ts';
export { CtxKvServer } from './lib/server/ctx-kv/durable-object.ts';
export { CtxTagsServer } from './lib/server/ctx-tags/durable-object.ts';
export { CtxQualityServer } from './lib/server/ctx-quality/durable-object.ts';
export { CtxMetaServer } from './lib/server/ctx-meta/durable-object.ts';
export { HeartbeatServer } from './lib/server/heartbeat/durable-object.ts';
export { ProtocolPingsServer } from './lib/server/protocol-pings/durable-object.ts';
export { FullImportServer } from './lib/server/full-import/durable-object.ts';
export { MultifileServer } from './lib/server/multifile/durable-object.ts';

const FEATURE_ROUTES: Record<string, keyof Env> = {
  '/ws/incoming': 'INCOMING_SERVER',
  '/ws/request': 'REQUEST_SERVER',
  '/ws/stream-basic': 'STREAM_BASIC_SERVER',
  '/ws/stream-nudges': 'STREAM_NUDGES_SERVER',
  '/ws/stream-broadcast': 'STREAM_BROADCAST_SERVER',
  '/ws/channel-static': 'CHANNEL_STATIC_SERVER',
  '/ws/channel-dynamic': 'CHANNEL_DYNAMIC_SERVER',
  '/ws/channel-scope-isolation': 'CHANNEL_SCOPE_ISOLATION_SERVER',
  '/ws/channel-key-collision': 'CHANNEL_KEY_COLLISION_SERVER',
  '/ws/lifecycle-hooks': 'LIFECYCLE_HOOKS_SERVER',
  '/ws/namespace': 'NAMESPACE_SERVER',
  '/ws/intercept': 'INTERCEPT_SERVER',
  '/ws/sequence': 'SEQUENCE_SERVER',
  '/ws/dedup': 'DEDUP_SERVER',
  '/ws/hibernation': 'HIBERNATION_SERVER',
  '/ws/scheduled': 'SCHEDULED_SERVER',
  '/ws/errors-factory': 'ERRORS_FACTORY_SERVER',
  '/ws/errors-control-flow': 'ERRORS_CONTROL_FLOW_SERVER',
  '/ws/ctx-send': 'CTX_SEND_SERVER',
  '/ws/ctx-channels': 'CTX_CHANNELS_SERVER',
  '/ws/ctx-sql': 'CTX_SQL_SERVER',
  '/ws/ctx-kv': 'CTX_KV_SERVER',
  '/ws/ctx-tags': 'CTX_TAGS_SERVER',
  '/ws/ctx-quality': 'CTX_QUALITY_SERVER',
  '/ws/ctx-meta': 'CTX_META_SERVER',
  '/ws/heartbeat': 'HEARTBEAT_SERVER',
  '/ws/protocol-pings': 'PROTOCOL_PINGS_SERVER',
  '/ws/full-import': 'FULL_IMPORT_SERVER',
  '/ws/multifile': 'MULTIFILE_SERVER',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get('room') ?? 'default';

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

    if (url.pathname === '/ws/modules/shutdown') {
      const id = env.MODULES_SERVER.idFromName(room);
      await env.MODULES_SERVER.get(id).shutdown();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws/reject-http') {
      const id = env.HTTP_REJECT_SERVER.idFromName(room);
      return env.HTTP_REJECT_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/ack') {
      const id = env.ACK_SERVER.idFromName(room);
      return env.ACK_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/binary') {
      const id = env.BINARY_SERVER.idFromName(room);
      return env.BINARY_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/lifecycle-hooks/shutdown') {
      const id = env.LIFECYCLE_HOOKS_SERVER.idFromName(room);
      await env.LIFECYCLE_HOOKS_SERVER.get(id).shutdown();
      return new Response(null, { status: 204 });
    }

    const featureBinding = FEATURE_ROUTES[url.pathname];
    if (featureBinding) {
      const namespace = env[featureBinding] as DurableObjectNamespace;
      const id = namespace.idFromName(room);
      return namespace.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
