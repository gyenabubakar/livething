/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { recordedDurableRegistrar } from '~/_engine/stream-durable/registrar.ts';
import { sweepDurableStreams } from '~/_engine/stream-durable/runtime.ts';
import { ensureDurableStreamSchema } from '~/_engine/stream-durable/storage.ts';
import { scheduled as scheduledFactory } from '~/scheduled/scheduled.ts';
import { compileRecordedStreamDef } from '~/stream-recorded/compile.ts';
import { recordedStream as recordedStreamDef } from '~/stream-recorded/definition.ts';
import { toNudgeDefs, wrapStreamGenerator } from '~/stream/shared.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';

type BuildDurableSweepCtxParameter = { sql: Parameters<typeof sweepDurableStreams>[0]['sql'] };

/** A `recordedStream()` capability, carrying the builder that turns a config into a primitive. */
export interface RecordedStreamCapability extends Capability<
  {},
  never,
  'recordedStream',
  typeof CAPABILITY_KIND.recordedStream
> {
  /** Build a recorded-stream primitive from a `base.recordedStream(...)` config. @internal */
  readonly __streamBuild: { kind: 'recorded'; build: (event: string, config: any) => Primitive };
  /** Build the recurring durable-stream retention sweep primitive. @internal */
  readonly __durableSweep: () => Primitive;
}

function buildDurableSweep(): Primitive {
  return scheduledFactory('__livething:stream-durable-sweep', (b) =>
    b.every(60_000).run((ctx: BuildDurableSweepCtxParameter) => {
      ensureDurableStreamSchema(ctx.sql);
      sweepDurableStreams({ sql: ctx.sql });
    }),
  );
}

/**
 * Enable recorded server-pushed streams. Listing this lets you register
 * `base.recordedStream(name, { input, run })`. Chunks are buffered as they
 * emit; on reconnect the client receives the chunks it missed — the generator
 * does not re-run. Best for non-resumable sources such as model tokens.
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { recordedStream } from '@livething/server/streams';
 * import * as v from 'valibot';
 *
 * const base = server({ capabilities: [recordedStream()] });
 *
 * export const handleTokens = base.recordedStream('tokens', {
 *   input: v.object({}),
 *   async *run() {
 *     for (const token of await generateTokens()) yield { token };
 *   },
 * });
 *
 * export const server = base.assemble({ handlers: [handleTokens] });
 * ```
 */
export const recordedStream = withCapabilityKind(
  function recordedStream(): RecordedStreamCapability {
    const cap = capability<{}, never, 'recordedStream', typeof CAPABILITY_KIND.recordedStream>([
      recordedDurableRegistrar(),
    ]) as RecordedStreamCapability;
    (cap as { __streamBuild: RecordedStreamCapability['__streamBuild'] }).__streamBuild = {
      kind: 'recorded',
      build(event, config) {
        const def = recordedStreamDef(event, {
          payload: config.input,
          nudges: toNudgeDefs(config.nudges),
          broadcast: config.broadcast,
          allowConcurrent: config.allowConcurrent,
          highWaterMark: config.highWaterMark,
          onDisconnect: config.onDisconnect,
          maxChunks: config.maxChunks,
          maxAgeMs: config.maxAgeMs,
          retentionAfterEndMs: config.retentionAfterEndMs,
        });
        const handlers = new Map([[event, wrapStreamGenerator(config.run)]]);
        return compileRecordedStreamDef(def, handlers);
      },
    };
    (cap as { __durableSweep: RecordedStreamCapability['__durableSweep'] }).__durableSweep =
      buildDurableSweep;
    return stampKind(cap, CAPABILITY_KIND.recordedStream);
  },
  CAPABILITY_KIND.recordedStream,
);
