/* oxlint-disable @typescript-eslint/no-explicit-any */
import { generate as generateFactory, stream as streamFactory } from '~/stream/stream.ts';
import type { Primitive } from '~/primitive.ts';
import type { NudgeDef, StreamDef } from '~/stream/definition.ts';

// Returns two primitives: one declares the stream, the other holds the generator.
export function compileStreamDef(
  def: StreamDef,
  handlers: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>,
): readonly Primitive[] {
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
  return [streamPrim, generateFactory(streamPrim, generator as any)];
}
