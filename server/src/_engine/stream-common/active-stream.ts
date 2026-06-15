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

  /** The scope the stream runs in, used to gate nudges to the same scope. */
  scope?: ResolvedScope;

  /**
   * The stop controller for this stream. The runtime creates it before building
   * the generator (so `ctx.stream.signal` can read its `.signal`) and passes it
   * in here. If omitted, a fresh controller is created.
   */
  abortController?: AbortController;

  /**
   * Outbound backpressure limit in bytes. `ctx.stream.drain()` resolves once the
   * buffered amount is below this mark. Defaults to {@link DEFAULT_HIGH_WATER_MARK}.
   */
  highWaterMark?: number;
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
    scope: input.scope,
    abortController: input.abortController ?? new AbortController(),
    highWaterMark: input.highWaterMark ?? DEFAULT_HIGH_WATER_MARK,
  };
  return { active, nudgeBuffer };
}

/**
 * Default outbound backpressure limit per connection, in bytes (256 KB). Used
 * when a stream config omits `highWaterMark`.
 */
export const DEFAULT_HIGH_WATER_MARK = 256 * 1024;

/** A poll step for `drain` — defaults to `setTimeout`; injectable for tests. */
export type DrainDelay = (ms: number) => Promise<void>;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** How often `drain()` re-checks the buffer while it is over the mark, in ms. */
const DRAIN_POLL_INTERVAL_MS = 25;

/** Hard cap on poll iterations so a stuck buffer can never hang the generator forever. */
const DRAIN_MAX_POLLS = 2000;

/** A single connection's view of its outbound buffer, as drain needs it. */
export interface DrainTarget {
  readonly descriptor: { bufferedAmount(): number; backpressureSupported?: boolean };
}

export interface BuildDrainInput {
  /**
   * The connections drain paces against. One entry for a single-client stream;
   * the live target list for a broadcast stream. Resolved lazily on each call so
   * a broadcast picks up the current membership.
   */
  targets: () => readonly DrainTarget[];
  highWaterMark: number;
  /** True once the stream is torn down — drain resolves at once instead of hanging. */
  isClosed: () => boolean;
  delay?: DrainDelay;
}

/**
 * Whether a target's platform reports real buffer pressure. Cloudflare sets
 * `backpressureSupported: false`, so its buffer reading is meaningless and drain
 * must treat it as a no-op.
 */
function targetSupportsBackpressure(target: DrainTarget): boolean {
  return target.descriptor.backpressureSupported === true;
}

/**
 * Build the `ctx.stream.drain()` function for one stream.
 *
 * Resolves immediately when the outbound buffer is healthy (below the high water
 * mark). Otherwise it polls on a small interval until the buffer drains, then
 * resolves — pausing the generator so it does not outrun the network.
 *
 * For a broadcast stream the generator paces against the *healthiest* client
 * (the one with the least buffered data), never the slowest: drain resolves as
 * soon as the best target is below the mark. A slow client is not allowed to
 * stall the whole fan-out.
 *
 * On a platform that does not expose buffer fullness (Cloudflare —
 * `descriptor.backpressureSupported !== true`), drain resolves immediately as a
 * documented no-op.
 */
export function buildDrain(input: BuildDrainInput): () => Promise<void> {
  const delay = input.delay ?? defaultDelay;

  /** The healthiest buffered amount across targets that report real pressure. */
  function healthiestBuffered(): number | null {
    let best: number | null = null;
    for (const target of input.targets()) {
      if (!targetSupportsBackpressure(target)) continue;
      const buffered = target.descriptor.bufferedAmount();
      if (best === null || buffered < best) best = buffered;
    }
    return best;
  }

  return async function drain(): Promise<void> {
    for (let poll = 0; poll < DRAIN_MAX_POLLS; poll += 1) {
      // The stream is being torn down — never hang a draining generator.
      if (input.isClosed()) return;
      const best = healthiestBuffered();
      // No target reports real backpressure (Cloudflare, or no live targets): no-op.
      if (best === null) return;
      if (best < input.highWaterMark) return;
      await delay(DRAIN_POLL_INTERVAL_MS);
    }
  };
}

/**
 * Install `ctx.stream.drain()` on the raw stream context so `adaptStreamContext`
 * can lift it onto the unified `ctx.stream` handle. Call before building the
 * generator.
 */
export function installCtxDrain(
  ctx: Record<PropertyKey, unknown>,
  drain: () => Promise<void>,
): void {
  ctx.drain = drain;
}

/**
 * Reasons the stream stop signal can carry, surfaced as the abort reason on
 * `ctx.stream.signal.reason`.
 */
export type StreamAbortReason = 'cancelled' | 'aborted' | 'unsubscribed' | 'shutdown';

/**
 * Fire a stream's stop signal once. Idempotent — a second call (e.g. cancel
 * racing disconnect) is a no-op because the controller is already aborted.
 */
export function abortActiveStream(
  active: { abortController?: AbortController },
  reason: StreamAbortReason,
): void {
  const controller = active.abortController;
  if (!controller || controller.signal.aborted) return;
  controller.abort(reason);
}

/**
 * Install the per-stream stop signal on the raw stream context so the unified
 * `ctx.stream` handle (built by `adaptStreamContext`) can expose it as
 * `ctx.stream.signal`. Call before building the generator.
 */
export function installCtxSignal(
  ctx: Record<PropertyKey, unknown>,
  controller: AbortController,
): void {
  ctx.signal = controller.signal;
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

export interface AssertNoConcurrentStreamOptions {
  event: string;
  allowConcurrent: boolean;
}

/**
 * Refuse to start a second stream for the same event on the same connection
 * unless `allowConcurrent` is true. Mirrors plain stream's pre-flight check.
 */
export function assertNoConcurrentStream(
  runtime: { activeStreams: ReadonlyMap<string, ActiveStream> },
  connection: RuntimeConnection,
  options: AssertNoConcurrentStreamOptions,
): void {
  const { event, allowConcurrent } = options;
  if (allowConcurrent) return;
  const ids = connection.activeStreamIds;
  if (!ids) return;
  for (const id of ids) {
    const existing = runtime.activeStreams.get(id);
    if (existing && !existing.closed && existing.event === event) {
      throw StreamAlreadyActive({ event, streamId: existing.id });
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
 * membership; top-level fans out to every connection minus the creator. Pass
 * `extraFilter` to drop subscribers selectively (e.g. identities that
 * unsubscribed from a broadcast stream).
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
