import { adminDefinition } from '@livething/tests-e2e-handlers/admin';
import { broadcastRequestDefinition } from '@livething/tests-e2e-handlers/broadcast-request';
import { channelCheckCommitDefinition } from '@livething/tests-e2e-handlers/channel-check-commit';
import { channelDynamicDefinition } from '@livething/tests-e2e-handlers/channel-dynamic';
import { channelFamilyIsolationDefinition } from '@livething/tests-e2e-handlers/channel-family-isolation';
import { channelKeyCollisionDefinition } from '@livething/tests-e2e-handlers/channel-key-collision';
import { channelStaticDefinition } from '@livething/tests-e2e-handlers/channel-static';
import { ctxChannelsDefinition } from '@livething/tests-e2e-handlers/ctx-channels';
import { ctxKvDefinition } from '@livething/tests-e2e-handlers/ctx-kv';
import { ctxLocalsDefinition } from '@livething/tests-e2e-handlers/ctx-locals';
import { ctxMetaDefinition } from '@livething/tests-e2e-handlers/ctx-meta';
import { ctxQualityDefinition } from '@livething/tests-e2e-handlers/ctx-quality';
import { ctxSendDefinition } from '@livething/tests-e2e-handlers/ctx-send';
import { ctxSqlDefinition } from '@livething/tests-e2e-handlers/ctx-sql';
import { ctxTagsDefinition } from '@livething/tests-e2e-handlers/ctx-tags';
import { dedupDefinition } from '@livething/tests-e2e-handlers/dedup';
import { durableConfigDefinition } from '@livething/tests-e2e-handlers/durable-config';
import { errorHookIsolationDefinition } from '@livething/tests-e2e-handlers/error-hook-isolation';
import { errorsControlFlowDefinition } from '@livething/tests-e2e-handlers/errors-control-flow';
import { errorsFactoryDefinition } from '@livething/tests-e2e-handlers/errors-factory';
import { groupFullSurfaceDefinition } from '@livething/tests-e2e-handlers/group-full-surface';
import { heartbeatDefinition } from '@livething/tests-e2e-handlers/heartbeat';
import { heartbeatKeepaliveDefinition } from '@livething/tests-e2e-handlers/heartbeat-keepalive';
import { inboxDefinition } from '@livething/tests-e2e-handlers/inbox';
import { inboxDynamicDefinition } from '@livething/tests-e2e-handlers/inbox-dynamic';
import { inboxGapDefinition } from '@livething/tests-e2e-handlers/inbox-gap';
import { inboxHandleDefinition } from '@livething/tests-e2e-handlers/inbox-handle';
import { inboxRetentionDefinition } from '@livething/tests-e2e-handlers/inbox-retention';
import { incomingDefinition } from '@livething/tests-e2e-handlers/incoming';
import { interceptDefinition } from '@livething/tests-e2e-handlers/intercept';
import { keepaliveDefinition } from '@livething/tests-e2e-handlers/keepalive';
import { lastSeenDefinition } from '@livething/tests-e2e-handlers/last-seen';
import { lifecycleHooksDefinition } from '@livething/tests-e2e-handlers/lifecycle-hooks';
import { rejectHttpDefinition } from '@livething/tests-e2e-handlers/lifecycle-hooks-http-reject';
import { multiStateDefinition } from '@livething/tests-e2e-handlers/multi-state';
import { multifileDefinition } from '@livething/tests-e2e-handlers/multifile';
import { persistenceDefinition } from '@livething/tests-e2e-handlers/persistence';
import { protocolPingsDefinition } from '@livething/tests-e2e-handlers/protocol-pings';
import { rateLimitDefinition } from '@livething/tests-e2e-handlers/rate-limit';
import { receiptsDefinition } from '@livething/tests-e2e-handlers/receipts';
import { replayCustomDefinition } from '@livething/tests-e2e-handlers/replay-custom';
import { replayCustomCascadeDefinition } from '@livething/tests-e2e-handlers/replay-custom-cascade';
import { replayFamilyKeyEqualsNameDefinition } from '@livething/tests-e2e-handlers/replay-family-key-equals-name';
import { replayGapDefinition } from '@livething/tests-e2e-handlers/replay-gap';
import { replayDefinition } from '@livething/tests-e2e-handlers/replay-history';
import { replayMembershipGateDefinition } from '@livething/tests-e2e-handlers/replay-membership-gate';
import { replaySnapshotDefinition } from '@livething/tests-e2e-handlers/replay-snapshot';
import { requestDefinition } from '@livething/tests-e2e-handlers/request';
import { scheduledDefinition } from '@livething/tests-e2e-handlers/scheduled';
import { sequenceDefinition } from '@livething/tests-e2e-handlers/sequence';
import { serverRequestDefinition } from '@livething/tests-e2e-handlers/server-request';
import { staticVsFamilyIsolationDefinition } from '@livething/tests-e2e-handlers/static-vs-family-isolation';
import { streamBackpressureDefinition } from '@livething/tests-e2e-handlers/stream-backpressure';
import { streamBasicDefinition } from '@livething/tests-e2e-handlers/stream-basic';
import { streamBroadcastDefinition } from '@livething/tests-e2e-handlers/stream-broadcast';
import { streamDurableDefinition } from '@livething/tests-e2e-handlers/stream-durable';
import { streamDurableBroadcastDefinition } from '@livething/tests-e2e-handlers/stream-durable-broadcast';
import { streamDurableScopedDefinition } from '@livething/tests-e2e-handlers/stream-durable-scoped';
import { streamNudgesDefinition } from '@livething/tests-e2e-handlers/stream-nudges';
import { streamSignalDefinition } from '@livething/tests-e2e-handlers/stream-signal';
import {
  translationDefinition,
  translationInboundOnlyDefinition,
  translationPassThroughDefinition,
} from '@livething/tests-e2e-handlers/translation';
import { typedTagsDefinition } from '@livething/tests-e2e-handlers/typed-tags';
import type { ServerDefinition } from '@livething/server/adapters';
import { pluginsDefinition } from './plugins.ts';

export const FEATURE_DEFINITIONS: Record<string, ServerDefinition> = {
  '/ws/admin': adminDefinition,
  '/ws/incoming': incomingDefinition,
  '/ws/request': requestDefinition,
  '/ws/server-request': serverRequestDefinition,
  '/ws/broadcast-request': broadcastRequestDefinition,
  '/ws/stream-basic': streamBasicDefinition,
  '/ws/stream-signal': streamSignalDefinition,
  '/ws/stream-backpressure': streamBackpressureDefinition,
  '/ws/stream-nudges': streamNudgesDefinition,
  '/ws/stream-broadcast': streamBroadcastDefinition,
  '/ws/channel-static': channelStaticDefinition,
  '/ws/channel-dynamic': channelDynamicDefinition,
  '/ws/persistence': persistenceDefinition,
  '/ws/typed-tags': typedTagsDefinition,
  '/ws/channel-family-isolation': channelFamilyIsolationDefinition,
  '/ws/channel-key-collision': channelKeyCollisionDefinition,
  '/ws/error-hook-isolation': errorHookIsolationDefinition,
  '/ws/replay-membership-gate': replayMembershipGateDefinition,
  '/ws/replay-custom-cascade': replayCustomCascadeDefinition,
  '/ws/static-vs-family-isolation': staticVsFamilyIsolationDefinition,
  '/ws/replay-family-key-equals-name': replayFamilyKeyEqualsNameDefinition,
  '/ws/lifecycle-hooks': lifecycleHooksDefinition,
  '/ws/reject-http': rejectHttpDefinition,
  '/ws/intercept': interceptDefinition,
  '/ws/sequence': sequenceDefinition,
  '/ws/dedup': dedupDefinition,
  '/ws/scheduled': scheduledDefinition,
  '/ws/errors-factory': errorsFactoryDefinition,
  '/ws/errors-control-flow': errorsControlFlowDefinition,
  '/ws/ctx-send': ctxSendDefinition,
  '/ws/ctx-channels': ctxChannelsDefinition,
  '/ws/ctx-sql': ctxSqlDefinition,
  '/ws/ctx-kv': ctxKvDefinition,
  '/ws/ctx-tags': ctxTagsDefinition,
  '/ws/ctx-quality': ctxQualityDefinition,
  '/ws/ctx-meta': ctxMetaDefinition,
  '/ws/keepalive': keepaliveDefinition,
  '/ws/protocol-pings': protocolPingsDefinition,
  '/ws/heartbeat': heartbeatDefinition,
  '/ws/heartbeat-keepalive': heartbeatKeepaliveDefinition,
  '/ws/multifile': multifileDefinition,
  '/ws/rate-limit': rateLimitDefinition,
  '/ws/stream-durable': streamDurableDefinition,
  '/ws/stream-durable-scoped': streamDurableScopedDefinition,
  '/ws/stream-durable-broadcast': streamDurableBroadcastDefinition,
  '/ws/group-full-surface': groupFullSurfaceDefinition,
  '/ws/channel-check-commit': channelCheckCommitDefinition,
  '/ws/ctx-locals': ctxLocalsDefinition,
  '/ws/multi-state': multiStateDefinition,
  '/ws/durable-config': durableConfigDefinition,
  '/ws/inbox': inboxDefinition,
  '/ws/inbox-dynamic': inboxDynamicDefinition,
  '/ws/inbox-retention': inboxRetentionDefinition,
  '/ws/receipts': receiptsDefinition,
  '/ws/inbox-gap': inboxGapDefinition,
  '/ws/inbox-handle': inboxHandleDefinition,
  '/ws/last-seen': lastSeenDefinition,
  '/ws/translation': translationDefinition,
  '/ws/translation-inbound-only': translationInboundOnlyDefinition,
  '/ws/translation-pass-through': translationPassThroughDefinition,
  '/ws/plugins': pluginsDefinition,
  '/ws/replay': replayDefinition,
  '/ws/replay-gap': replayGapDefinition,
  '/ws/replay-custom': replayCustomDefinition,
  '/ws/replay-snapshot': replaySnapshotDefinition,
};
