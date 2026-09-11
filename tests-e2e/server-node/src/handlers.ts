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
import {
  translationHandler,
  translationInboundOnlyHandler,
  translationPassThroughHandler,
} from '@wskit/tests-e2e-handlers/translation';
import { typedTagsHandler } from '@wskit/tests-e2e-handlers/typed-tags';
import type { ServerDefinition } from '@wskit/server/adapters';
import { pluginsHandler } from './plugins.ts';

export const FEATURE_HANDLERS: Record<string, ServerDefinition> = {
  '/ws/admin': adminHandler,
  '/ws/incoming': incomingHandler,
  '/ws/request': requestHandler,
  '/ws/server-request': serverRequestHandler,
  '/ws/broadcast-request': broadcastRequestHandler,
  '/ws/stream-basic': streamBasicHandler,
  '/ws/stream-signal': streamSignalHandler,
  '/ws/stream-backpressure': streamBackpressureHandler,
  '/ws/stream-nudges': streamNudgesHandler,
  '/ws/stream-broadcast': streamBroadcastHandler,
  '/ws/channel-static': channelStaticHandler,
  '/ws/channel-dynamic': channelDynamicHandler,
  '/ws/persistence': persistenceHandler,
  '/ws/typed-tags': typedTagsHandler,
  '/ws/channel-family-isolation': channelFamilyIsolationHandler,
  '/ws/channel-key-collision': channelKeyCollisionHandler,
  '/ws/error-hook-isolation': errorHookIsolationHandler,
  '/ws/replay-membership-gate': replayMembershipGateHandler,
  '/ws/replay-custom-cascade': replayCustomCascadeHandler,
  '/ws/static-vs-family-isolation': staticVsFamilyIsolationHandler,
  '/ws/replay-family-key-equals-name': replayFamilyKeyEqualsNameHandler,
  '/ws/lifecycle-hooks': lifecycleHooksHandler,
  '/ws/reject-http': rejectHttpHandler,
  '/ws/intercept': interceptHandler,
  '/ws/sequence': sequenceHandler,
  '/ws/dedup': dedupHandler,
  '/ws/scheduled': scheduledHandler,
  '/ws/errors-factory': errorsFactoryHandler,
  '/ws/errors-control-flow': errorsControlFlowHandler,
  '/ws/ctx-send': ctxSendHandler,
  '/ws/ctx-channels': ctxChannelsHandler,
  '/ws/ctx-sql': ctxSqlHandler,
  '/ws/ctx-kv': ctxKvHandler,
  '/ws/ctx-tags': ctxTagsHandler,
  '/ws/ctx-quality': ctxQualityHandler,
  '/ws/ctx-meta': ctxMetaHandler,
  '/ws/keepalive': keepaliveHandler,
  '/ws/protocol-pings': protocolPingsHandler,
  '/ws/heartbeat': heartbeatHandler,
  '/ws/heartbeat-keepalive': heartbeatKeepaliveHandler,
  '/ws/multifile': multifileHandler,
  '/ws/rate-limit': rateLimitHandler,
  '/ws/stream-durable': streamDurableHandler,
  '/ws/stream-durable-scoped': streamDurableScopedHandler,
  '/ws/stream-durable-broadcast': streamDurableBroadcastHandler,
  '/ws/group-full-surface': groupFullSurfaceHandler,
  '/ws/channel-check-commit': channelCheckCommitHandler,
  '/ws/ctx-locals': ctxLocalsHandler,
  '/ws/multi-state': multiStateHandler,
  '/ws/durable-config': durableConfigHandler,
  '/ws/inbox': inboxHandler,
  '/ws/inbox-dynamic': inboxDynamicHandler,
  '/ws/inbox-retention': inboxRetentionHandler,
  '/ws/receipts': receiptsHandler,
  '/ws/inbox-gap': inboxGapHandler,
  '/ws/inbox-handle': inboxHandleHandler,
  '/ws/last-seen': lastSeenHandler,
  '/ws/translation': translationHandler,
  '/ws/translation-inbound-only': translationInboundOnlyHandler,
  '/ws/translation-pass-through': translationPassThroughHandler,
  '/ws/plugins': pluginsHandler,
  '/ws/replay': replayHandler,
  '/ws/replay-gap': replayGapHandler,
  '/ws/replay-custom': replayCustomHandler,
  '/ws/replay-snapshot': replaySnapshotHandler,
};
