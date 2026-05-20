/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Helpers shared by the plain-stream, resumable-stream, and recorded-stream
 * runtimes. They all build the same `ActiveStream` shape, install the same
 * `ctx.nudges()` helper, and resolve the same broadcast target list.
 */

import { StreamAlreadyActive } from '@wskit/core';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type {
  ActiveStream,
  OnDisconnect,
  ResolvedScope,
  RuntimeConnection,
} from '~/_engine/runtime/types.ts';

/** Validator handle used to type-narrow a registered nudge. */
export interface NudgeBinding {
  readonly event: string;
  readonly validator?: unknown;
}

/** Inputs accepted by `buildActiveStream`. */
export interface BuildActiveStreamInput {
  streamId: string;
  event: string;
  connection: RuntimeConnection;
  generator: AsyncGenerator<unknown, void, unknown>;
  nudges: readonly NudgeBinding[];
  /**
   * Disconnect policy for durable streams. Optional — defaults to
   * `'cancel-but-buffer'` (and non-durable streams leave it undefined).
   */
  onDisconnect?: OnDisconnect;
}

/** Return value from `buildActiveStream`. */
export interface ActiveStreamHandle {
  active: ActiveStream;
  nudgeBuffer: { event: string; payload: unknown }[];
}

/**
 * Build an `ActiveStream` shared by the plain-stream and durable-stream
 * runtimes. The runtime registers `active` on its `activeStreams` map; the
 * generator loop drains `nudgeBuffer` between yields to feed each
 * `iterator.next(value)` call.
 */
export function buildActiveStream(input: BuildActiveStreamInput): ActiveStreamHandle {
  const nudgeBuffer: { event: string; payload: unknown }[] = [];
  const nudgeValidators = new Map<string, unknown>();
  for (const nudge of input.nudges) {
    nudgeValidators.set(nudge.event, nudge.validator);
  }
  const active: ActiveStream = {
    id: input.streamId,
    connectionId: input.connection.id,
    event: input.event,
    generator: input.generator,
    nudges: nudgeBuffer,
    nudgeValidators,
    closed: false,
    onDisconnect: input.onDisconnect,
    connection: input.connection,
  };
  return { active, nudgeBuffer };
}

/**
 * Install the `ctx.nudges()` helper that returns the value passed to the
 * iterator's `.next(value)` call when it is an array, otherwise an empty
 * list. Mirrors the plain-stream behaviour so generator code works the same
 * way across all three primitives.
 */
export function installCtxNudges(ctx: Record<PropertyKey, unknown>): void {
  ctx.nudges = (value: unknown) => (Array.isArray(value) ? value : []);
}

/**
 * Refuse to start a second stream for the same event on the same connection
 * unless `allowConcurrent` is true. Mirrors plain stream's pre-flight check.
 */
export function assertNoConcurrentStream(
  runtime: { activeStreams: ReadonlyMap<string, ActiveStream> },
  connection: RuntimeConnection,
  event: string,
  allowConcurrent: boolean,
): void {
  if (allowConcurrent) return;
  const ids = connection.activeStreamIds;
  if (!ids) return;
  for (const id of ids) {
    const existing = runtime.activeStreams.get(id);
    if (existing && !existing.closed && existing.event === event) {
      throw StreamAlreadyActive({ event, _streamId: existing.id });
    }
  }
}

/** Inputs accepted by `resolveBroadcastTargets`. */
export interface BroadcastTargetInput {
  runtime: { connections: ReadonlyMap<string, RuntimeConnection> };
  excludeConnectionId: string;
  scope: ResolvedScope;
  extraFilter?: (candidate: RuntimeConnection) => boolean;
}

/**
 * Walk every connection on the runtime and return the ones that should
 * receive a broadcast chunk. Channel-scoped streams require channel
 * membership; namespace and top-level fan out to every connection minus the
 * creator. Pass `extraFilter` to drop subscribers selectively (e.g.
 * identities that unsubscribed from a broadcast stream).
 */
export function resolveBroadcastTargets(input: BroadcastTargetInput): RuntimeConnection[] {
  const targets: RuntimeConnection[] = [];
  for (const candidate of input.runtime.connections.values()) {
    if (candidate.id === input.excludeConnectionId) continue;
    if (input.scope.channelName) {
      if (
        !ChannelPrimitive.hasChannelMembership(
          candidate,
          input.scope.channelName,
          input.scope.channelScope ?? null,
        )
      ) {
        continue;
      }
    }
    if (input.extraFilter && !input.extraFilter(candidate)) continue;
    targets.push(candidate);
  }
  return targets;
}
