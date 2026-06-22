/* oxlint-disable @typescript-eslint/no-explicit-any */
import { generate as generateFactory, stream as streamFactory } from '~/stream/stream.ts';
import type { Primitive } from '~/primitive.ts';
import type { NudgeDef, StreamDef } from '~/stream/definition.ts';

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
      highWaterMark: def.highWaterMark,
    },
    ...def.nudges.map((n: NudgeDef) => ({ event: n.name, validator: n.schema })),
  );
  return generateFactory(streamPrim, generator as any);
}
