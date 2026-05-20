/* oxlint-disable @typescript-eslint/no-explicit-any */
import { generate as generateFactory, stream as streamFactory } from '~/stream/stream.ts';
import type { Primitive } from '~/primitive.ts';
import type { NudgeDef, StreamDef } from '~/stream/definition.ts';

// Returns ONE primitive — the handler-bound `'stream-generate'`. The
// declaration primitive `streamFactory(...)` is built internally and held by
// the handler primitive's `.stream` field, but it is NOT emitted as its own
// primitive: the engine compile switch doesn't read a standalone `'stream'`
// tag, and emitting one as dead weight added confusion. Module deps that
// want to reference the feature can still point at `streamFactory.__key`.
export function compileStreamDef(
  def: StreamDef,
  handlers: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>,
): Primitive {
  const generator = handlers.get(def.name);
  if (!generator) {
    throw new Error(
      `[wskit] No generator registered for stream('${def.name}'). Call implement(c).stream('${def.name}', ...).`,
    );
  }
  const streamPrim = streamFactory(
    {
      event: def.name,
      validator: def.payload,
      broadcast: def.broadcast,
      allowConcurrent: def.allowConcurrent,
    },
    ...def.nudges.map((n: NudgeDef) => ({ event: n.name, validator: n.schema })),
  );
  return generateFactory(streamPrim, generator as any);
}
