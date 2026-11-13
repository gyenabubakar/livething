/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Durable-stream dispatch surface.
 *
 * This is the seam the engine's message hub talks to instead of importing the
 * durable-stream runtime directly. The `recordedStream()` capability registers
 * `durableStreamService` during `__setup`, so a server that does not list it
 * never pulls the durable runtime or its storage layer into its bundle.
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

type OptionsParameter = { continueScope: ResolvedChannel; streamId: string; lastKnownSeq: number };
type OptionsParameter2 = { streamId: string; cancelScope: ResolvedChannel };

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

/** Build the runtime def the durable engine consumes from a compiled recorded stream. */
function buildRuntimeDef(
  durable: EngineCompileTypes.AnyRecordedStream,
): DurableStreamRuntime.DurableStreamRuntimeDef {
  return {
    event: durable.event,
    generator: durable.generator,
    allowConcurrent: durable.allowConcurrent,
    broadcast: durable.broadcast,
    nudges: durable.nudges,
    maxChunks: durable.maxChunks,
    maxBufferBytes: durable.maxBufferBytes,
    maxAgeMs: durable.maxAgeMs,
    retentionAfterEndMs: durable.retentionAfterEndMs,
  };
}

/**
 * Find the compiled durable-stream def for a stored row, in the scope the row
 * was started in. Returns undefined if the def or scope is gone, or the
 * continuing connection is not a member of the stream's channel.
 */
function resolveDurableDefForRow(
  runtime: any,
  connection: RuntimeConnection,
  row: DurableStreamStorage.DurableStreamRow,
): { def: DurableStreamRuntime.DurableStreamRuntimeDef; scope: ResolvedChannel } | undefined {
  let scope: ResolvedChannel = {};
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
    recorded = channel.recordedStreams.get(row.event);
  } else {
    recorded = runtime.compiled.recordedStreams.get(row.event);
  }

  return recorded ? { scope, def: buildRuntimeDef(recorded) } : undefined;
}

/** The durable-stream dispatch service registered with the engine. */
export const durableStreamService: DurableStreamService = {
  async trigger(
    runtime: any,
    connection: RuntimeConnection,
    options: DurableTriggerOptions,
  ): Promise<void> {
    const { scope, durable, payload, livething, bytes } = options;
    ensureSchemaOnce(runtime);
    await DurableStreamRuntime.runDurableStream(runtime, connection, {
      scope,
      def: buildRuntimeDef(durable),
      payload,
      livething,
      bytes,
    });
  },

  async continue(
    runtime: any,
    connection: RuntimeConnection,
    options: OptionsParameter,
  ): Promise<void> {
    const { continueScope, streamId, lastKnownSeq } = options;
    ensureSchemaOnce(runtime);
    const row = DurableStreamRuntime.findContinueRow(runtime, connection, {
      continueScope,
      streamId,
    });
    await DurableStreamRuntime.continueDurableStream(runtime, connection, {
      resolveDef: (matched) => resolveDurableDefForRow(runtime, connection, matched),
      row,
      streamId,
      lastKnownSeq,
    });
  },

  async cancel(
    runtime: any,
    connection: RuntimeConnection,
    options: OptionsParameter2,
  ): Promise<void> {
    await DurableStreamRuntime.cancelDurableStream(runtime, connection, options);
  },

  endOnLeave(runtime: any, connection: RuntimeConnection, options): void {
    ensureSchemaOnce(runtime);
    DurableStreamRuntime.endDurableStreamOnLeave(runtime, connection, options);
  },
};
