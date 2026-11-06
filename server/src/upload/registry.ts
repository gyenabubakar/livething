import type { UploadPrimitive } from './upload.ts';

/**
 * The upload handlers of each engine, keyed by the engine's SQL handle, which is one per
 * engine and which the dispatch runtime and the engine access share. The expiry sweep runs
 * outside any frame, so it finds `onDiscard` here.
 */
const handlersByEngine = new WeakMap<object, Map<string, UploadPrimitive>>();

export function registerUploadHandler(engineSql: object, primitive: UploadPrimitive): void {
  let handlers = handlersByEngine.get(engineSql);
  if (!handlers) {
    handlers = new Map();
    handlersByEngine.set(engineSql, handlers);
  }

  handlers.set(primitive.event, primitive);
}

export function uploadHandler(engineSql: object, event: string): UploadPrimitive | undefined {
  return handlersByEngine.get(engineSql)?.get(event);
}
