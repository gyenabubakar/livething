/* oxlint-disable @typescript-eslint/no-explicit-any */
import { binaryPayloadOf } from '~/outgoing/binary-payload.ts';
import { adaptStreamContext } from '~/stream/ctx-adapter.ts';
import { nudge } from '~/stream/definition.ts';
import type { NudgeDef } from '~/stream/definition.ts';
import type { Validator } from '~/types.ts';

/**
 * Helpers shared by both stream capabilities (plain, recorded). They live
 * apart from the plain-stream engine so that listing only `recordedStream`
 * does not pull the plain stream engine into the bundle.
 */

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

  return Object.entries(nudges).map((entry) =>
    entry[1] ? nudge(entry[0], entry[1] as any) : nudge(entry[0]),
  );
}

/**
 * Wrap a user generator so it receives the unified `ctx.stream` handle.
 *
 * @internal
 */
export function wrapStreamGenerator(run: StreamGenerator): StreamGenerator {
  return (ctx, payload, bytes) => run(adaptStreamContext(ctx), payload, bytes);
}

/** @internal */
export type StreamGenerator = (
  ctx: any,
  payload: any,
  bytes?: Uint8Array,
) => AsyncGenerator<unknown, void, unknown>;

/**
 * A binary stream's generator yields `{ info, bytes }`. Turn each chunk into the payload that
 * the send path writes as one binary frame. The value passed to `next()` (the nudges) and an
 * error a recorded stream throws in (`buffer-full`) go through as they are.
 *
 * @internal
 */
export function binaryChunks(method: string, run: StreamGenerator): StreamGenerator {
  return (ctx, payload, bytes) => {
    const inner = run(ctx, payload, bytes);
    async function chunk(
      step: Promise<IteratorResult<unknown, void>>,
    ): Promise<IteratorResult<unknown, void>> {
      const result = await step;
      if (result.done) return result;

      return { done: false, value: binaryPayloadOf(method, result.value, true) };
    }

    const wrapped = {
      next: (value: unknown) => chunk(inner.next(value)),
      return: (value: void) => inner.return(value),
      throw: (error: unknown) => chunk(inner.throw(error)),
      [Symbol.asyncIterator]: () => wrapped,
    } as unknown as AsyncGenerator<unknown, void, unknown>;

    return wrapped;
  };
}
