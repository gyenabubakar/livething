/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import { cursorGenerateFactory } from './stream-cursor.ts';
import type { CursorStreamDef } from './definition.ts';

type CursorHandlers = Map<
  string,
  (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>
>;

/**
 * Pair a `CursorStreamDef` with a generator selected during assembly and
 * produce the runtime primitive the engine mounts. Throws when the stream's
 * handler value was not assembled.
 */
export function compileCursorStreamDef(def: CursorStreamDef, handlers: CursorHandlers): Primitive {
  const generator = handlers.get(def.name);
  if (!generator) {
    throw new Error(
      `[livething] No handler assembled for cursorStream('${def.name}'). Include the value returned by base.cursorStream(...) in base.assemble({ handlers: [...] }).`,
    );
  }

  if (def.onDisconnect === 'keep-running' && !def.broadcast) {
    throw new Error(
      `[livething] cursorStream('${def.name}') has onDisconnect: 'keep-running' but broadcast is off. ` +
        `A cursor stream never buffers chunks (only its cursor), so with no broadcast peer every ` +
        `chunk produced while the client is gone reaches nobody and is lost. Set broadcast: true so ` +
        `live peers keep receiving, or switch to recordedStream if a reconnecting client must replay ` +
        `the chunks it missed.`,
    );
  }

  return cursorGenerateFactory({
    event: def.name,
    validator: def.payload,
    cursor: def.cursor,
    generator,
    allowConcurrent: def.allowConcurrent,
    broadcast: def.broadcast,
    onDisconnect: def.onDisconnect ?? 'cancel-but-buffer',
    nudges: def.nudges.map((n) => ({ event: n.name, validator: n.schema })),
    maxAgeMs: def.maxAgeMs ?? 5 * 60_000,
    retentionAfterEndMs: def.retentionAfterEndMs ?? 30_000,
    highWaterMark: def.highWaterMark,
  });
}
