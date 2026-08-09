/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Durable-stream dispatch surface.
 *
 * This is the seam the engine's message hub talks to instead of importing the
 * durable-stream runtime directly. The `resumableStream()` / `recordedStream()`
 * capabilities register `durableStreamService` during `__setup`, so a handler
 * that lists neither never pulls the durable runtime, its storage layer, or the
 * cursor codec into its bundle.
 */

import * as ChannelPrimitive from '~/channel/runtime.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type {
  DurableStreamService,
  DurableTriggerOptions,
} from '~/_engine/runtime/feature-slots.ts';
import type { ResolvedChannel, RuntimeConnection } from '~/_engine/runtime/types.ts';
import * as DurableStreamRuntime from './runtime.ts';
import { ensureDurableStreamSchema } from './storage.ts';
import type * as DurableStreamStorage from './storage.ts';

/**
 * Run the durable-stream DDL once per engine instance. The dispatch bag tracks
 * whether it has already run so repeat triggers skip the redundant check.
 */
function ensureSchemaOnce(runtime: any): void {
  if (!runtime.durableStreamSchemaReady) {
    ensureDurableStreamSchema(runtime.sql);
    runtime.durableStreamSchemaReady = true;
  }
}

/**
 * Build the runtime def the durable engine consumes from a compiled
 * resumable/recorded stream. `maxChunks` is recorded-only and `cursor` is
 * resumable-only.
 */
function buildRuntimeDef(
  durable: any,
  kind: 'resumable' | 'recorded',
): DurableStreamRuntime.DurableStreamRuntimeDef {
  return {
    event: durable.event,
    kind,
    generator: durable.generator,
    allowConcurrent: durable.allowConcurrent,
    broadcast: durable.broadcast ?? false,
    nudges: durable.nudges,
    maxChunks: kind === 'recorded' ? durable.maxChunks : undefined,
    maxAgeMs: durable.maxAgeMs,
    retentionAfterEndMs: durable.retentionAfterEndMs,
    cursor: kind === 'resumable' ? durable.cursor : undefined,
    onDisconnect: durable.onDisconnect,
    highWaterMark: durable.highWaterMark,
  };
}

/**
 * Find the compiled durable-stream def for a stored row, in the scope the row
 * was started in. Returns undefined if the def or scope is gone, or the
 * resuming connection is not a member of the stream's channel.
 */
function resolveDurableDefForRow(
  runtime: any,
  connection: RuntimeConnection,
  row: DurableStreamStorage.DurableStreamRow,
): { def: DurableStreamRuntime.DurableStreamRuntimeDef; scope: ResolvedChannel } | undefined {
  let scope: ResolvedChannel = {};
  let resumable: EngineCompileTypes.AnyResumableStream | undefined;
  let recorded: EngineCompileTypes.AnyRecordedStream | undefined;

  if (row.channelKey) {
    const channel =
      row.channelFamily !== null
        ? runtime.compiled.channelFamilies.get(row.channelFamily)
        : runtime.compiled.channels.get(row.channelKey);
    if (!channel) return undefined;
    if (!ChannelPrimitive.hasChannelMembership(connection, row.channelKey, row.channelFamily)) {
      return undefined;
    }
    scope = { channel, channelName: row.channelKey, channelFamily: row.channelFamily };
    resumable = channel.resumableStreams.get(row.event);
    recorded = channel.recordedStreams.get(row.event);
  } else {
    resumable = runtime.compiled.resumableStreams.get(row.event);
    recorded = runtime.compiled.recordedStreams.get(row.event);
  }

  if (resumable) {
    return { scope, def: buildRuntimeDef(resumable, 'resumable') };
  }
  if (recorded) {
    return { scope, def: buildRuntimeDef(recorded, 'recorded') };
  }
  return undefined;
}

/** The durable-stream dispatch service registered with the engine. */
export const durableStreamService: DurableStreamService = {
  ensureSchema(runtime: any): void {
    ensureSchemaOnce(runtime);
  },

  async trigger(
    runtime: any,
    connection: RuntimeConnection,
    options: DurableTriggerOptions,
  ): Promise<void> {
    const { scope, durable, kind, payload, wskit } = options;
    ensureSchemaOnce(runtime);
    await DurableStreamRuntime.runDurableStream(runtime, connection, {
      scope,
      def: buildRuntimeDef(durable, kind),
      payload,
      wskit,
    });
  },

  async resume(
    runtime: any,
    connection: RuntimeConnection,
    options: { resumeScope: ResolvedChannel; streamId: string; lastKnownSeq: number },
  ): Promise<void> {
    const { resumeScope, streamId, lastKnownSeq } = options;
    ensureSchemaOnce(runtime);
    const row = DurableStreamRuntime.findResumeRow(runtime, connection, { resumeScope, streamId });
    await DurableStreamRuntime.resumeDurableStream(runtime, connection, {
      resolveDef: (matched) => resolveDurableDefForRow(runtime, connection, matched),
      row,
      streamId,
      lastKnownSeq,
    });
  },

  async cancel(
    runtime: any,
    connection: RuntimeConnection,
    options: { streamId: string; cancelScope: ResolvedChannel },
  ): Promise<void> {
    await DurableStreamRuntime.cancelDurableStream(runtime, connection, options);
  },
};
