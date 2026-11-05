/* oxlint-disable @typescript-eslint/no-explicit-any */
import { generate as generateFactory, stream as streamFactory } from '~/stream/stream.ts';
import type { Primitive } from '~/primitive.ts';
import type { NudgeDef, StreamDef } from '~/stream/definition.ts';

export function compileStreamDef(
  def: StreamDef,
  handlers: Map<
    string,
    (ctx: any, payload: any, bytes?: Uint8Array) => AsyncGenerator<any, void, unknown>
  >,
): Primitive {
  const generator = handlers.get(def.name);
  if (!generator) {
    throw new Error(
      `[livething] No handler assembled for stream('${def.name}'). Include the value returned by base.stream(...) in base.assemble({ handlers: [...] }).`,
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
