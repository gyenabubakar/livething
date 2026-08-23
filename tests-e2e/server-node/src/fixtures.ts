import { adminHandler } from '@wskit/tests-e2e-handlers/admin';
import { broadcastRequestHandler } from '@wskit/tests-e2e-handlers/broadcast-request';
import { channelCheckCommitHandler } from '@wskit/tests-e2e-handlers/channel-check-commit';
import { channelDynamicHandler } from '@wskit/tests-e2e-handlers/channel-dynamic';
import { channelFamilyIsolationHandler } from '@wskit/tests-e2e-handlers/channel-family-isolation';
import { channelKeyCollisionHandler } from '@wskit/tests-e2e-handlers/channel-key-collision';
import { channelStaticHandler } from '@wskit/tests-e2e-handlers/channel-static';
import { ctxChannelsHandler } from '@wskit/tests-e2e-handlers/ctx-channels';
import { ctxKvHandler } from '@wskit/tests-e2e-handlers/ctx-kv';
import { ctxLocalsHandler } from '@wskit/tests-e2e-handlers/ctx-locals';
import { ctxMetaHandler } from '@wskit/tests-e2e-handlers/ctx-meta';
import { ctxQualityHandler } from '@wskit/tests-e2e-handlers/ctx-quality';
import { ctxSendHandler } from '@wskit/tests-e2e-handlers/ctx-send';
import { ctxSqlHandler } from '@wskit/tests-e2e-handlers/ctx-sql';
import { ctxTagsHandler } from '@wskit/tests-e2e-handlers/ctx-tags';
import { dedupHandler } from '@wskit/tests-e2e-handlers/dedup';
import { durableConfigHandler } from '@wskit/tests-e2e-handlers/durable-config';
import { errorHookIsolationHandler } from '@wskit/tests-e2e-handlers/error-hook-isolation';
import { errorsControlFlowHandler } from '@wskit/tests-e2e-handlers/errors-control-flow';
import { errorsFactoryHandler } from '@wskit/tests-e2e-handlers/errors-factory';
import { groupFullSurfaceHandler } from '@wskit/tests-e2e-handlers/group-full-surface';
import { heartbeatHandler } from '@wskit/tests-e2e-handlers/heartbeat';
import { heartbeatKeepaliveHandler } from '@wskit/tests-e2e-handlers/heartbeat-keepalive';
import { inboxHandler } from '@wskit/tests-e2e-handlers/inbox';
import { inboxDynamicHandler } from '@wskit/tests-e2e-handlers/inbox-dynamic';
import { inboxGapHandler } from '@wskit/tests-e2e-handlers/inbox-gap';
import { inboxHandleHandler } from '@wskit/tests-e2e-handlers/inbox-handle';
import { inboxRetentionHandler } from '@wskit/tests-e2e-handlers/inbox-retention';
import { incomingHandler } from '@wskit/tests-e2e-handlers/incoming';
import { interceptHandler } from '@wskit/tests-e2e-handlers/intercept';
import { keepaliveHandler } from '@wskit/tests-e2e-handlers/keepalive';
import { lastSeenHandler } from '@wskit/tests-e2e-handlers/last-seen';
import { lifecycleHooksHandler } from '@wskit/tests-e2e-handlers/lifecycle-hooks';
import { rejectHttpHandler } from '@wskit/tests-e2e-handlers/lifecycle-hooks-http-reject';
import { multiStateHandler } from '@wskit/tests-e2e-handlers/multi-state';
import { multifileHandler } from '@wskit/tests-e2e-handlers/multifile';
import { persistenceHandler } from '@wskit/tests-e2e-handlers/persistence';
import { protocolPingsHandler } from '@wskit/tests-e2e-handlers/protocol-pings';
import { rateLimitHandler } from '@wskit/tests-e2e-handlers/rate-limit';
import { receiptsHandler } from '@wskit/tests-e2e-handlers/receipts';
import { replayCustomHandler } from '@wskit/tests-e2e-handlers/replay-custom';
import { replayCustomCascadeHandler } from '@wskit/tests-e2e-handlers/replay-custom-cascade';
import { replayFamilyKeyEqualsNameHandler } from '@wskit/tests-e2e-handlers/replay-family-key-equals-name';
import { replayGapHandler } from '@wskit/tests-e2e-handlers/replay-gap';
import { replayHandler } from '@wskit/tests-e2e-handlers/replay-history';
import { replayMembershipGateHandler } from '@wskit/tests-e2e-handlers/replay-membership-gate';
import { replaySnapshotHandler } from '@wskit/tests-e2e-handlers/replay-snapshot';
import { requestHandler } from '@wskit/tests-e2e-handlers/request';
import { scheduledHandler } from '@wskit/tests-e2e-handlers/scheduled';
import { sequenceHandler } from '@wskit/tests-e2e-handlers/sequence';
import { serverRequestHandler } from '@wskit/tests-e2e-handlers/server-request';
import { staticVsFamilyIsolationHandler } from '@wskit/tests-e2e-handlers/static-vs-family-isolation';
import { streamBackpressureHandler } from '@wskit/tests-e2e-handlers/stream-backpressure';
import { streamBasicHandler } from '@wskit/tests-e2e-handlers/stream-basic';
import { streamBroadcastHandler } from '@wskit/tests-e2e-handlers/stream-broadcast';
import { streamDurableHandler } from '@wskit/tests-e2e-handlers/stream-durable';
import { streamDurableBroadcastHandler } from '@wskit/tests-e2e-handlers/stream-durable-broadcast';
import { streamDurableScopedHandler } from '@wskit/tests-e2e-handlers/stream-durable-scoped';
import { streamNudgesHandler } from '@wskit/tests-e2e-handlers/stream-nudges';
import { streamSignalHandler } from '@wskit/tests-e2e-handlers/stream-signal';
import { typedTagsHandler } from '@wskit/tests-e2e-handlers/typed-tags';
import { bind } from './bind.ts';
import { pluginsHandler } from './plugins.ts';
import {
  createTranslationInboundOnlyServer,
  createTranslationPassThroughServer,
  createTranslationServer,
} from './translation.ts';
import type { NodeFixtureFactory } from './bind.ts';

export interface FixtureSpec {
  create: NodeFixtureFactory;
}

export const FEATURE_ROUTES: Record<string, FixtureSpec> = {
  '/ws/admin': { create: bind(adminHandler) },
  '/ws/incoming': { create: bind(incomingHandler) },
  '/ws/request': { create: bind(requestHandler) },
  '/ws/server-request': { create: bind(serverRequestHandler) },
  '/ws/broadcast-request': { create: bind(broadcastRequestHandler) },
  '/ws/stream-basic': { create: bind(streamBasicHandler) },
  '/ws/stream-signal': { create: bind(streamSignalHandler) },
  '/ws/stream-backpressure': { create: bind(streamBackpressureHandler) },
  '/ws/stream-nudges': { create: bind(streamNudgesHandler) },
  '/ws/stream-broadcast': { create: bind(streamBroadcastHandler) },
  '/ws/channel-static': { create: bind(channelStaticHandler) },
  '/ws/channel-dynamic': { create: bind(channelDynamicHandler) },
  '/ws/persistence': { create: bind(persistenceHandler) },
  '/ws/typed-tags': { create: bind(typedTagsHandler) },
  '/ws/channel-family-isolation': { create: bind(channelFamilyIsolationHandler) },
  '/ws/channel-key-collision': { create: bind(channelKeyCollisionHandler) },
  '/ws/error-hook-isolation': { create: bind(errorHookIsolationHandler) },
  '/ws/replay-membership-gate': { create: bind(replayMembershipGateHandler) },
  '/ws/replay-custom-cascade': { create: bind(replayCustomCascadeHandler) },
  '/ws/static-vs-family-isolation': { create: bind(staticVsFamilyIsolationHandler) },
  '/ws/replay-family-key-equals-name': { create: bind(replayFamilyKeyEqualsNameHandler) },
  '/ws/lifecycle-hooks': { create: bind(lifecycleHooksHandler) },
  '/ws/reject-http': { create: bind(rejectHttpHandler) },
  '/ws/intercept': { create: bind(interceptHandler) },
  '/ws/sequence': { create: bind(sequenceHandler) },
  '/ws/dedup': { create: bind(dedupHandler) },
  '/ws/scheduled': { create: bind(scheduledHandler) },
  '/ws/errors-factory': { create: bind(errorsFactoryHandler) },
  '/ws/errors-control-flow': { create: bind(errorsControlFlowHandler) },
  '/ws/ctx-send': { create: bind(ctxSendHandler) },
  '/ws/ctx-channels': { create: bind(ctxChannelsHandler) },
  '/ws/ctx-sql': { create: bind(ctxSqlHandler) },
  '/ws/ctx-kv': { create: bind(ctxKvHandler) },
  '/ws/ctx-tags': { create: bind(ctxTagsHandler) },
  '/ws/ctx-quality': { create: bind(ctxQualityHandler) },
  '/ws/ctx-meta': { create: bind(ctxMetaHandler) },
  '/ws/keepalive': { create: bind(keepaliveHandler) },
  '/ws/protocol-pings': { create: bind(protocolPingsHandler) },
  '/ws/heartbeat': { create: bind(heartbeatHandler) },
  '/ws/heartbeat-keepalive': { create: bind(heartbeatKeepaliveHandler) },
  '/ws/multifile': { create: bind(multifileHandler) },
  '/ws/rate-limit': { create: bind(rateLimitHandler) },
  '/ws/stream-durable': { create: bind(streamDurableHandler) },
  '/ws/stream-durable-scoped': { create: bind(streamDurableScopedHandler) },
  '/ws/stream-durable-broadcast': { create: bind(streamDurableBroadcastHandler) },
  '/ws/group-full-surface': { create: bind(groupFullSurfaceHandler) },
  '/ws/channel-check-commit': { create: bind(channelCheckCommitHandler) },
  '/ws/ctx-locals': { create: bind(ctxLocalsHandler) },
  '/ws/multi-state': { create: bind(multiStateHandler) },
  '/ws/durable-config': { create: bind(durableConfigHandler) },
  '/ws/inbox': { create: bind(inboxHandler) },
  '/ws/inbox-dynamic': { create: bind(inboxDynamicHandler) },
  '/ws/inbox-retention': { create: bind(inboxRetentionHandler) },
  '/ws/receipts': { create: bind(receiptsHandler) },
  '/ws/inbox-gap': { create: bind(inboxGapHandler) },
  '/ws/inbox-handle': { create: bind(inboxHandleHandler) },
  '/ws/last-seen': { create: bind(lastSeenHandler) },
  '/ws/translation': { create: createTranslationServer },
  '/ws/translation-inbound-only': { create: createTranslationInboundOnlyServer },
  '/ws/translation-pass-through': { create: createTranslationPassThroughServer },
  '/ws/plugins': { create: bind(pluginsHandler) },
  '/ws/replay': { create: bind(replayHandler) },
  '/ws/replay-gap': { create: bind(replayGapHandler) },
  '/ws/replay-custom': { create: bind(replayCustomHandler) },
  '/ws/replay-snapshot': { create: bind(replaySnapshotHandler) },
};
