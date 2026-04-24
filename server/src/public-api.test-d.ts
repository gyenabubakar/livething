/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixture: package public API surface.
 *
 * This file validates which symbols remain exported from each public feature
 * path and which ones are intentionally hidden.
 */

import { ack, withAck } from '~/ack/index.ts';
// @ts-expect-error — hidden channel primitive layer
import { channel, withChannels } from '~/channel/index.ts';
import { dedup, withDedup } from '~/dedup/index.ts';
import { Block, error, errors, withErrors } from '~/errors/index.ts';
import { heartbeat, withHeartbeat } from '~/heartbeat/index.ts';
import { hibernation, withHibernation } from '~/hibernation/index.ts';
// @ts-expect-error — hidden from the root public API
import { defineModule, event, scope, server, ServerBuilder } from '~/index.ts';
// @ts-expect-error — hidden intercept primitive layer
import { intercept, withIntercept } from '~/intercept/index.ts';
// @ts-expect-error — hidden lifecycle primitive layer
import { onInit, withLifecycle } from '~/lifecycle/index.ts';
// @ts-expect-error — hidden namespace primitive layer
import { namespace, withNamespaces } from '~/namespace/index.ts';
import { replay, withReplay } from '~/replay/index.ts';
// @ts-expect-error — hidden request primitive layer
import { request, withRequests } from '~/request/index.ts';
import { scheduled, withScheduled } from '~/scheduled/index.ts';
import { sequence, withSequence } from '~/sequence/index.ts';
// @ts-expect-error — hidden stream primitive layer
import { nudge, withStreams } from '~/stream/index.ts';
// @ts-expect-error — hidden primitive type
import type { AckPrimitive } from '~/ack/index.ts';
import type {
  ChannelHandlerContext,
  ScopeDeclaration as ChannelScopeDeclaration,
  ChannelStreamHandlerContext,
} from '~/channel/index.ts';
// @ts-expect-error — hidden primitive type
import type { DedupPrimitive } from '~/dedup/index.ts';
// @ts-expect-error — hidden primitive type
import type { ErrorsPrimitive } from '~/errors/index.ts';
// @ts-expect-error — hidden primitive type
import type { HeartbeatOptions, HeartbeatPrimitive } from '~/heartbeat/index.ts';
// @ts-expect-error — hidden primitive type
import type { HibernationPrimitive } from '~/hibernation/index.ts';
// @ts-expect-error — hidden from the root public API
import type { EventContract, GroupPrimitive, ModuleHooks, ScopeDeclaration } from '~/index.ts';
import type { InterceptMessage } from '~/intercept/index.ts';
import type { UpgradeResult } from '~/lifecycle/index.ts';
import type { NamespaceHandlerContext, NamespaceStreamHandlerContext } from '~/namespace/index.ts';
// @ts-expect-error — hidden replay primitive type
import type { ReplayOptions, ReplayPrimitive } from '~/replay/index.ts';
// @ts-expect-error — hidden scheduled internals
import type { ScheduledHandle, ScheduledOptions, ScheduledPrimitive } from '~/scheduled/index.ts';
// @ts-expect-error — hidden primitive type
import type { SequenceOptions, SequencePrimitive } from '~/sequence/index.ts';
import type {
  NudgeMessage,
  StreamHandlerContext,
  StreamNudgeMessages,
  StreamNudgesApi,
} from '~/stream/index.ts';

void server;
void event;
void scope;
void defineModule;
void withAck;
void ack;
void withHeartbeat;
void heartbeat;
void withSequence;
void sequence;
void withDedup;
void dedup;
void withHibernation;
void hibernation;
void withErrors;
void error;
void errors;
void Block;
void withScheduled;
void scheduled;
void withRequests;
void withIntercept;
void withChannels;
void withNamespaces;
void withStreams;
void withReplay;
void replay;
void withLifecycle;

export type _RootKeep = [EventContract<'x', {}>, ScopeDeclaration<'room'>, ModuleHooks];
export type _FeatureKeep = [
  HeartbeatOptions,
  SequenceOptions,
  ScheduledOptions,
  InterceptMessage,
  ChannelHandlerContext,
  ChannelStreamHandlerContext,
  ChannelScopeDeclaration<'room'>,
  NamespaceHandlerContext,
  NamespaceStreamHandlerContext,
  NudgeMessage,
  StreamHandlerContext<{}, readonly []>,
  StreamNudgeMessages<readonly []>,
  StreamNudgesApi<readonly []>,
  ReplayOptions,
  UpgradeResult,
];
