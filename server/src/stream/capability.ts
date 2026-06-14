/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { compileStreamDef } from '~/stream/compile.ts';
import { adaptStreamContext } from '~/stream/ctx-adapter.ts';
import { nudge, stream as streamDef } from '~/stream/definition.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { NudgeDef } from '~/stream/definition.ts';
import type { Validator } from '~/types.ts';

/** The nudge map a stream config accepts: event name → schema, or `null` for no payload. @internal */
export type NudgeMap = Record<string, Validator | null>;

/**
 * Turn the new authoring API's nudge map into the definition-side nudge array.
 * A `null` value means "no payload"; any other value is treated as a schema.
 *
 * @internal
 */
export function toNudgeDefs(nudges?: NudgeMap): NudgeDef[] {
  if (!nudges) return [];
  return Object.entries(nudges).map(([name, schema]) =>
    schema ? nudge(name, schema as any) : nudge(name),
  );
}

/**
 * Wrap a user generator so it receives the unified `ctx.stream` handle.
 *
 * @internal
 */
export function wrapStreamGenerator(
  run: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>,
): (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown> {
  return (ctx, payload) => run(adaptStreamContext(ctx), payload);
}

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
 * import { define, t } from '@wskit/server';
 * import { stream } from '@wskit/server/streams';
 * import * as v from 'valibot';
 *
 * const base = define({ env: t<Env>(), capabilities: [stream()] });
 *
 * export const handleFeed = base.stream('feed', {
 *   input: v.object({ count: v.number() }),
 *   async *run(ctx, input) {
 *     for (let i = 0; i < input.count; i += 1) yield { index: i };
 *   },
 * });
 * ```
 */
export const stream = withCapabilityKind(function stream(): StreamCapability {
  const cap = capability<{}, never, 'stream'>([]) as StreamCapability;
  (cap as { __streamBuild: StreamCapability['__streamBuild'] }).__streamBuild = {
    kind: 'plain',
    build(event, config) {
      const def = streamDef(event, {
        payload: config.input,
        nudges: toNudgeDefs(config.nudges),
        broadcast: config.broadcast,
        allowConcurrent: config.allowConcurrent,
      });
      const handlers = new Map([[event, wrapStreamGenerator(config.run)]]);
      return compileStreamDef(def, handlers);
    },
  };
  return stampKind(cap, CAPABILITY_KIND.stream);
}, CAPABILITY_KIND.stream);
