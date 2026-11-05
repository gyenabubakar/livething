export { ReplayServer } from './replay-history.ts';
export { ReplayGapServer } from './replay-gap.ts';
export { ReplaySnapshotServer } from './replay-snapshot.ts';
export { PluginsServer } from './plugins.ts';
export { AdminServer } from './admin.ts';
export { RejectHttpServer } from './lifecycle-hooks-http-reject.ts';
export { IncomingServer } from './incoming.ts';
export { BinaryServer } from './binary.ts';
export { RequestServer } from './request.ts';
export { ServerRequestServer } from './server-request.ts';
export { StreamBasicServer } from './stream-basic.ts';
export { StreamSignalServer } from './stream-signal.ts';
export { StreamBackpressureServer } from './stream-backpressure.ts';
export { StreamNudgesServer } from './stream-nudges.ts';
export { StreamBroadcastServer } from './stream-broadcast.ts';
export { ChannelStaticServer } from './channel-static.ts';
export { ChannelDynamicServer } from './channel-dynamic.ts';
export { PersistenceServer } from './persistence.ts';
export { TypedTagsServer } from './typed-tags.ts';
export { ChannelFamilyIsolationServer } from './channel-family-isolation.ts';
export { ChannelKeyCollisionServer } from './channel-key-collision.ts';
export { ErrorHookIsolationServer } from './error-hook-isolation.ts';
export { StaticVsFamilyIsolationServer } from './static-vs-family-isolation.ts';
export { ReplayFamilyKeyEqualsNameServer } from './replay-family-key-equals-name.ts';
export { LifecycleHooksServer } from './lifecycle-hooks.ts';
export { InterceptServer } from './intercept.ts';
export { SequenceServer } from './sequence.ts';
export { DedupServer } from './dedup.ts';
export { HibernationServer } from './hibernation.ts';
export { ScheduledServer } from './scheduled.ts';
export { ErrorsFactoryServer } from './errors-factory.ts';
export { ErrorsControlFlowServer } from './errors-control-flow.ts';
export { CtxSendServer } from './ctx-send.ts';
export { CtxChannelsServer } from './ctx-channels.ts';
export { CtxSqlServer } from './ctx-sql.ts';
export { CtxKvServer } from './ctx-kv.ts';
export { CtxTagsServer } from './ctx-tags.ts';
export { CtxQualityServer } from './ctx-quality.ts';
export { CtxMetaServer } from './ctx-meta.ts';
export { KeepaliveServer } from './keepalive.ts';
export { ProtocolPingsServer } from './protocol-pings.ts';
export { HeartbeatServer } from './heartbeat.ts';
export { HeartbeatKeepaliveServer } from './heartbeat-keepalive.ts';
export { HeartbeatHibernationServer } from './heartbeat-hibernation.ts';
export { MultifileServer } from './multifile.ts';
export { RateLimitServer } from './rate-limit.ts';
export { StreamDurableServer } from './stream-durable.ts';
export { StreamDurableScopedServer } from './stream-durable-scoped.ts';
export { StreamDurableBroadcastServer } from './stream-durable-broadcast.ts';
export { GroupFullSurfaceServer } from './group-full-surface.ts';
export { ChannelCheckCommitServer } from './channel-check-commit.ts';
export { CtxLocalsServer } from './ctx-locals.ts';
export { MultiStateServer } from './multi-state.ts';
export { DurableConfigServer } from './durable-config.ts';
export { InboxServer } from './inbox.ts';
export { InboxDynamicServer } from './inbox-dynamic.ts';
export { InboxRetentionServer } from './inbox-retention.ts';
export { ReceiptsServer } from './receipts.ts';
export { InboxGapServer } from './inbox-gap.ts';
export { InboxHandleServer } from './inbox-handle.ts';
export { LastSeenServer } from './last-seen.ts';

/** Returned when a route names an op that has no case below. */
const UNKNOWN_OP = Symbol('unknown-op');

interface AdminOpArgs {
  text: string;
  userId: string;
  channel: string;
  url: URL;
}

type AdminStub = Awaited<ReturnType<ReturnType<Env['ADMIN_SERVER']['get']>['admin']>>;

/**
 * Drive one member of the admin ctx through the app's own `api`. Each case
 * returns something observable so the test asserts on a value, not on silence.
 */
type AdminOperation = (admin: AdminStub, args: AdminOpArgs) => Promise<unknown> | unknown;

const ADMIN_OPERATIONS: Record<string, AdminOperation> = {
  'count-now': (admin) => admin.countNow(),
  'who-is-online': (admin) => admin.whoIsOnline(),
  'connection-ids-of': (admin, { userId }) => admin.connectionIdsOf(userId),
  'poke-connection': (admin, { text, url }) =>
    admin.pokeConnection(url.searchParams.get('connectionId') ?? '', text),
  'close-connection': (admin, { url }) =>
    admin.closeConnection(
      url.searchParams.get('connectionId') ?? '',
      Number(url.searchParams.get('code') ?? '1000'),
      url.searchParams.get('reason') ?? '',
    ),
  'notify-user': (admin, { text, userId }) => admin.notifyUser(userId, text),
  'boot-user': (admin, { userId }) => admin.bootUser(userId) ?? null,
  'announce-in': (admin, { channel, text }) => admin.announceIn(channel, text) ?? null,
  'members-of': (admin, { channel }) => admin.membersOf(channel),
  'kick-from': async (admin, { channel, userId }) =>
    (await admin.kickFrom(channel, userId)) ?? null,
  'schedule-announce': (admin, { text, url }) =>
    admin.scheduleAnnounce(Number(url.searchParams.get('delayMs') ?? '50'), text) ?? null,
  'cancel-announce': (admin) => admin.cancelAnnounce() ?? null,
  'write-note': (admin, { text }) => admin.writeNote(text) ?? null,
  'read-notes': (admin) => admin.readNotes(),
  'put-flag': async (admin, { text, url }) =>
    (await admin.putFlag(url.searchParams.get('key') ?? '', text)) ?? null,
  'get-flag': (admin, { url }) => admin.getFlag(url.searchParams.get('key') ?? ''),
  'log-something': (admin, { text }) => admin.logSomething(text) ?? null,
  'has-platform': (admin) => admin.hasPlatform(),
};

function runAdminOp(admin: AdminStub, op: string, args: AdminOpArgs): Promise<unknown> | unknown {
  const operation = ADMIN_OPERATIONS[op];
  return operation ? operation(admin, args) : UNKNOWN_OP;
}

/** Drive one built-in op on the stub, through the same nested shape the Node admin has. */
async function runAdminBuiltIn(
  admin: AdminStub,
  op: string,
  { text, userId, url }: Omit<AdminOpArgs, 'channel'>,
): Promise<unknown> {
  switch (op) {
    case 'connection-count':
      return admin.connectionCount;

    case 'list-connections': {
      const all = await admin.connections.all();
      return Promise.all(
        all.map(async (info) => ({
          id: info.id,
          userId: info.userId,
          refId: (await info.ref()).id,
          lastSeen: info.lastSeen ? await info.lastSeen() : 'missing',
        })),
      );
    }

    case 'send-to-connection': {
      const connectionId = url.searchParams.get('connectionId') ?? '';
      const info = (await admin.connections.all()).find((c) => c.id === connectionId);
      // An unknown id still goes through the stub, so the engine reports the miss.
      const ref = info
        ? await info.ref()
        : ({
            __livething: 'connection-ref',
            id: connectionId,
            userId: '',
            instance: undefined,
          } as const);
      return admin.connections.get(ref).send('poked', { text });
    }

    case 'send-to-user':
      return admin.users.get(userId).broadcast('notified', { text });

    case 'close-user':
      return (await admin.users.get(userId).close(4321, 'booted by admin')) ?? null;

    case 'broadcast':
      return (await admin.broadcast('announced', { text })) ?? null;

    case 'channel-broadcast':
      return (await admin.channels.broadcast('lobby', 'room-notice', { text })) ?? null;

    case 'channel-members':
      return (await admin.channels.get('lobby').members()).map((info) => info.userId);

    case 'channel-kick':
      return (
        (await admin.channels
          .get('lobby')
          .kick(await admin.users.get(userId).ref(), { reason: 'admin kick' })) ?? null
      );

    default:
      return UNKNOWN_OP;
  }
}

const FEATURE_ROUTES: Record<string, keyof Env> = {
  '/ws/admin': 'ADMIN_SERVER',
  '/ws/incoming': 'INCOMING_SERVER',
  '/ws/binary': 'BINARY_SERVER',
  '/ws/request': 'REQUEST_SERVER',
  '/ws/server-request': 'SERVER_REQUEST_SERVER',
  '/ws/stream-basic': 'STREAM_BASIC_SERVER',
  '/ws/stream-signal': 'STREAM_SIGNAL_SERVER',
  '/ws/stream-backpressure': 'STREAM_BACKPRESSURE_SERVER',
  '/ws/stream-nudges': 'STREAM_NUDGES_SERVER',
  '/ws/stream-broadcast': 'STREAM_BROADCAST_SERVER',
  '/ws/channel-static': 'CHANNEL_STATIC_SERVER',
  '/ws/channel-dynamic': 'CHANNEL_DYNAMIC_SERVER',
  '/ws/persistence': 'PERSISTENCE_SERVER',
  '/ws/typed-tags': 'TYPED_TAGS_SERVER',
  '/ws/channel-family-isolation': 'CHANNEL_FAMILY_ISOLATION_SERVER',
  '/ws/channel-key-collision': 'CHANNEL_KEY_COLLISION_SERVER',
  '/ws/error-hook-isolation': 'ERROR_HOOK_ISOLATION_SERVER',
  '/ws/static-vs-family-isolation': 'STATIC_VS_FAMILY_ISOLATION_SERVER',
  '/ws/replay-family-key-equals-name': 'REPLAY_FAMILY_KEY_EQUALS_NAME_SERVER',
  '/ws/lifecycle-hooks': 'LIFECYCLE_HOOKS_SERVER',
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
  '/ws/keepalive': 'KEEPALIVE_SERVER',
  '/ws/protocol-pings': 'PROTOCOL_PINGS_SERVER',
  '/ws/heartbeat': 'HEARTBEAT_SERVER',
  '/ws/heartbeat-keepalive': 'HEARTBEAT_KEEPALIVE_SERVER',
  '/ws/heartbeat-hibernation': 'HEARTBEAT_HIBERNATION_SERVER',
  '/ws/multifile': 'MULTIFILE_SERVER',
  '/ws/rate-limit': 'RATE_LIMIT_SERVER',
  '/ws/stream-durable': 'STREAM_DURABLE_SERVER',
  '/ws/stream-durable-scoped': 'STREAM_DURABLE_SCOPED_SERVER',
  '/ws/stream-durable-broadcast': 'STREAM_DURABLE_BROADCAST_SERVER',
  '/ws/group-full-surface': 'GROUP_FULL_SURFACE_SERVER',
  '/ws/channel-check-commit': 'CHANNEL_CHECK_COMMIT_SERVER',
  '/ws/ctx-locals': 'CTX_LOCALS_SERVER',
  '/ws/multi-state': 'MULTI_STATE_SERVER',
  '/ws/durable-config': 'DURABLE_CONFIG_SERVER',
  '/ws/inbox': 'INBOX_SERVER',
  '/ws/inbox-dynamic': 'INBOX_DYNAMIC_SERVER',
  '/ws/inbox-retention': 'INBOX_RETENTION_SERVER',
  '/ws/receipts': 'RECEIPTS_SERVER',
  '/ws/inbox-gap': 'INBOX_GAP_SERVER',
  '/ws/inbox-handle': 'INBOX_HANDLE_SERVER',
  '/ws/last-seen': 'LAST_SEEN_SERVER',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get('room') ?? 'default';

    if (url.pathname === '/ws/replay') {
      const id = env.REPLAY_SERVER.idFromName(room);
      return env.REPLAY_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/replay-gap') {
      const id = env.REPLAY_GAP_SERVER.idFromName(room);
      return env.REPLAY_GAP_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/replay-snapshot') {
      const id = env.REPLAY_SNAPSHOT_SERVER.idFromName(room);
      return env.REPLAY_SNAPSHOT_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/plugins') {
      const id = env.PLUGINS_SERVER.idFromName(room);
      return env.PLUGINS_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/plugins/shutdown') {
      const id = env.PLUGINS_SERVER.idFromName(room);
      await env.PLUGINS_SERVER.get(id).shutdown();
      return new Response(null, { status: 204 });
    }

    // Admin surface over the stub: a built-in op (purgeUser) and a
    // dev-defined op (announce), both reached through stub.admin().
    if (url.pathname === '/ws/admin/purge') {
      const id = env.ADMIN_SERVER.idFromName(room);
      const userId = url.searchParams.get('userId') ?? '';
      const admin = await env.ADMIN_SERVER.get(id).admin();
      await admin.purgeUser(userId);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws/admin/announce') {
      const id = env.ADMIN_SERVER.idFromName(room);
      const text = url.searchParams.get('text') ?? '';
      const admin = await env.ADMIN_SERVER.get(id).admin();
      await admin.announce(text);
      return new Response(null, { status: 204 });
    }

    // Every member of the admin ctx, driven through the app's own `api` over
    // the stub. One route per member so a failure names the member that broke.
    if (url.pathname.startsWith('/ws/admin/api/')) {
      const op = url.pathname.slice('/ws/admin/api/'.length);
      const id = env.ADMIN_SERVER.idFromName(room);
      const admin = await env.ADMIN_SERVER.get(id).admin();
      const text = url.searchParams.get('text') ?? '';
      const userId = url.searchParams.get('userId') ?? '';

      const channel = url.searchParams.get('channel') ?? 'lobby';

      const result = await runAdminOp(admin, op, { text, userId, channel, url });
      if (result === UNKNOWN_OP) return new Response(`unknown admin op: ${op}`, { status: 404 });

      return Response.json({ result });
    }

    // Built-in ops on the stub itself, distinct from the app's `api`.
    if (url.pathname.startsWith('/ws/admin/builtin/')) {
      const op = url.pathname.slice('/ws/admin/builtin/'.length);
      const id = env.ADMIN_SERVER.idFromName(room);
      const admin = await env.ADMIN_SERVER.get(id).admin();
      const text = url.searchParams.get('text') ?? '';
      const userId = url.searchParams.get('userId') ?? '';

      const result = await runAdminBuiltIn(admin, op, { text, userId, url });
      if (result === UNKNOWN_OP) return new Response(`unknown builtin op: ${op}`, { status: 404 });

      return Response.json({ result });
    }

    if (url.pathname === '/ws/reject-http') {
      const id = env.HTTP_REJECT_SERVER.idFromName(room);
      return env.HTTP_REJECT_SERVER.get(id).fetch(request);
    }

    if (url.pathname === '/ws/lifecycle-hooks/shutdown') {
      const id = env.LIFECYCLE_HOOKS_SERVER.idFromName(room);
      await env.LIFECYCLE_HOOKS_SERVER.get(id).shutdown();
      return new Response(null, { status: 204 });
    }

    // Test-only restart routes. `restart()` calls ctx.abort(), which discards
    // the DO's in-memory state while durable storage survives — simulating a
    // process restart / cross-deploy so durability is observable. The RPC never
    // returns cleanly (the instance is torn down mid-call), so the rejection is
    // expected and swallowed.
    if (url.pathname === '/ws/sequence/restart') {
      const id = env.SEQUENCE_SERVER.idFromName(room);
      try {
        await env.SEQUENCE_SERVER.get(id).restart();
      } catch {
        /* ctx.abort() tears down the instance, so the RPC stub rejects — expected. */
      }

      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws/persistence/restart') {
      const id = env.PERSISTENCE_SERVER.idFromName(room);
      try {
        await env.PERSISTENCE_SERVER.get(id).restart();
      } catch {
        /* expected — see above */
      }

      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws/scheduled/restart') {
      const id = env.SCHEDULED_SERVER.idFromName(room);
      try {
        await env.SCHEDULED_SERVER.get(id).restart();
      } catch {
        /* expected — see above */
      }

      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws/inbox-retention/restart') {
      const id = env.INBOX_RETENTION_SERVER.idFromName(room);
      try {
        await env.INBOX_RETENTION_SERVER.get(id).restart();
      } catch {
        /* expected — see above */
      }

      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws/receipts/seed-stale') {
      const id = env.RECEIPTS_SERVER.idFromName(room);
      await (await env.RECEIPTS_SERVER.get(id).admin()).seedStaleReceipt();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws/receipts/stale-count') {
      const id = env.RECEIPTS_SERVER.idFromName(room);
      const count = await (await env.RECEIPTS_SERVER.get(id).admin()).staleReceiptCount();
      return Response.json({ count });
    }

    if (url.pathname === '/ws/receipts/drop-inbox') {
      const id = env.RECEIPTS_SERVER.idFromName(room);
      await (await env.RECEIPTS_SERVER.get(id).admin()).dropInboxTable();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws/receipts/receivers') {
      const id = env.RECEIPTS_SERVER.idFromName(room);
      const users = await (
        await env.RECEIPTS_SERVER.get(id).admin()
      ).receiptUsers(
        url.searchParams.get('channel') ?? 'chat',
        Number(url.searchParams.get('seq') ?? 0),
      );
      return Response.json({ users });
    }

    if (url.pathname === '/ws/receipts/purge') {
      const id = env.RECEIPTS_SERVER.idFromName(room);
      try {
        await (await env.RECEIPTS_SERVER.get(id).admin()).purgeUser('alice');
        return new Response(null, { status: 204 });
      } catch {
        return new Response(null, { status: 500 });
      }
    }

    if (url.pathname === '/ws/receipts/restart') {
      const id = env.RECEIPTS_SERVER.idFromName(room);
      try {
        await env.RECEIPTS_SERVER.get(id).restart();
      } catch {
        /* expected — ctx.abort() tears down the instance */
      }

      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws/durable-config/restart') {
      const id = env.DURABLE_CONFIG_SERVER.idFromName(room);
      try {
        await env.DURABLE_CONFIG_SERVER.get(id).restart();
      } catch {
        /* expected — see above */
      }

      return new Response(null, { status: 204 });
    }

    const featureBinding = FEATURE_ROUTES[url.pathname];
    if (featureBinding) {
      const namespace = env[featureBinding] as DurableObjectNamespace;
      const id = namespace.idFromName(room);
      return namespace.get(id).fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
