/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { resumableDurableRegistrar } from '~/_engine/stream-durable/registrar.ts';
import { sweepDurableStreams } from '~/_engine/stream-durable/runtime.ts';
import { ensureDurableStreamSchema } from '~/_engine/stream-durable/storage.ts';
import { scheduled as scheduledFactory } from '~/scheduled/scheduled.ts';
import { compileResumableStreamDef } from '~/stream-resumable/compile.ts';
import { resumableStream as resumableStreamDef } from '~/stream-resumable/definition.ts';
import { toNudgeDefs, wrapStreamGenerator } from '~/stream/shared.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';

type BuildDurableSweepCtxParameter = { sql: Parameters<typeof sweepDurableStreams>[0]['sql'] };

/** A `resumableStream()` capability, carrying the builder that turns a config into a primitive. */
export interface ResumableStreamCapability extends Capability<
  {},
  never,
  'resumableStream',
  typeof CAPABILITY_KIND.resumableStream
> {
  /** Build a resumable-stream primitive from a `base.resumableStream(...)` config. @internal */
  readonly __streamBuild: { kind: 'resumable'; build: (event: string, config: any) => Primitive };
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
 * Enable resumable server-pushed streams. Listing this lets you register
 * `base.resumableStream(name, { input, cursor, run })`. The generator records a
 * cursor checkpoint with each chunk (`ctx.stream.withCursor(chunk, cursor)`);
 * after a reconnect it re-runs from the last confirmed checkpoint
 * (`ctx.stream.cursor`).
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { resumableStream } from '@livething/server/streams';
 * import * as v from 'valibot';
 *
 * const base = server({ capabilities: [resumableStream()] });
 *
 * export const handlePaginate = base.resumableStream('paginate', {
 *   input: v.object({}),
 *   cursor: t<{ row: number }>(),
 *   async *run(ctx) {
 *     const start = ctx.stream.cursor?.row ?? 0;
 *     for (let i = start + 1; i <= 100; i += 1) yield ctx.stream.withCursor({ row: i }, { row: i });
 *   },
 * });
 *
 * export const server = base.assemble({ handlers: [handlePaginate] });
 * ```
 */
export const resumableStream = withCapabilityKind(
  function resumableStream(): ResumableStreamCapability {
    const cap = capability<{}, never, 'resumableStream', typeof CAPABILITY_KIND.resumableStream>([
      resumableDurableRegistrar(),
    ]) as ResumableStreamCapability;
    (cap as { __streamBuild: ResumableStreamCapability['__streamBuild'] }).__streamBuild = {
      kind: 'resumable',
      build(event, config) {
        // A `t<T>()` cursor marker is type-only; only a real schema runtime-checks
        // a restored cursor, so drop the marker to skip validation.
        const cursor =
          config.cursor && (config.cursor as { __livething_t?: unknown }).__livething_t === 't'
            ? undefined
            : config.cursor;
        const def = resumableStreamDef(event, {
          payload: config.input,
          cursor,
          nudges: toNudgeDefs(config.nudges),
          broadcast: config.broadcast,
          allowConcurrent: config.allowConcurrent,
          highWaterMark: config.highWaterMark,
          onDisconnect: config.onDisconnect,
          maxAgeMs: config.maxAgeMs,
          retentionAfterEndMs: config.retentionAfterEndMs,
        });
        const handlers = new Map([[event, wrapStreamGenerator(config.run)]]);
        return compileResumableStreamDef(def, handlers);
      },
    };
    (cap as { __durableSweep: ResumableStreamCapability['__durableSweep'] }).__durableSweep =
      buildDurableSweep;
    return stampKind(cap, CAPABILITY_KIND.resumableStream);
  },
  CAPABILITY_KIND.resumableStream,
);
