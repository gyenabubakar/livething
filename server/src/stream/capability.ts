/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { definePrimitive } from '~/primitive.ts';
import { registerActiveStreamOps } from '~/stream/active-ops.ts';
import { compileStreamDef } from '~/stream/compile.ts';
import { stream as streamDef } from '~/stream/definition.ts';
import { runStream } from '~/stream/runtime.ts';
import { toNudgeDefs, wrapStreamGenerator } from '~/stream/shared.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';

const STREAM_RUNTIME_KEY = Symbol('stream-runtime');

/**
 * Registers the plain-stream trigger and the shared active-stream ops so the
 * engine's dispatch hub can run a matched `stream(...)` without importing the
 * stream runtime itself.
 */
const streamRuntimePrimitive = definePrimitive({
  tag: 'stream-runtime',
  key: STREAM_RUNTIME_KEY,
  kind: 'infrastructure',
  create: () => ({}),
  setup(engine) {
    engine.setStreamTrigger(runStream);
    registerActiveStreamOps(engine);
  },
});

/** A `stream()` capability, carrying the builder that turns a config into a primitive. */
export interface StreamCapability extends Capability<{}, never, 'stream'> {
  /** Build a plain-stream primitive from a `base.stream(...)` config. @internal */
  readonly __streamBuild: { kind: 'plain'; build: (event: string, config: any) => Primitive };
}

/**
 * Enable plain server-pushed streams. Listing this lets you register
 * `base.stream(name, { input, run })`, whose `run` is an async generator — each
 * value it yields is sent to the client as a chunk. One active stream per event
 * per connection by default.
 *
 * @example
 * ```ts
 * import { server, t } from '@wskit/server';
 * import { stream } from '@wskit/server/streams';
 * import * as v from 'valibot';
 *
 * const base = server({ capabilities: [stream()] });
 *
 * export const handleFeed = base.stream('feed', {
 *   input: v.object({ count: v.number() }),
 *   async *run(ctx, input) {
 *     for (let i = 0; i < input.count; i += 1) yield { index: i };
 *   },
 * });
 *
 * export const server = base.assemble({ handlers: [handleFeed] });
 * ```
 */
export const stream = withCapabilityKind(function stream(): StreamCapability {
  const cap = capability<{}, never, 'stream'>([streamRuntimePrimitive()]) as StreamCapability;
  (cap as { __streamBuild: StreamCapability['__streamBuild'] }).__streamBuild = {
    kind: 'plain',
    build(event, config) {
      const def = streamDef(event, {
        payload: config.input,
        nudges: toNudgeDefs(config.nudges),
        broadcast: config.broadcast,
        allowConcurrent: config.allowConcurrent,
        highWaterMark: config.highWaterMark,
      });
      const handlers = new Map([[event, wrapStreamGenerator(config.run)]]);
      return compileStreamDef(def, handlers);
    },
  };
  return stampKind(cap, CAPABILITY_KIND.stream);
}, CAPABILITY_KIND.stream);
