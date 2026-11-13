import { Block } from '@livething/core';
import type { Message, PrimitiveLogger } from '~/internal/runtime.ts';

/**
 * Run one message hook (a primitive's `onIncoming` / `onOutgoing`, or a plugin
 * wrapper) with the one true contract, so every call site behaves the same:
 *
 * - returns a message → pass it on (possibly transformed)
 * - returns `null` → the hook cancelled the message
 * - throws `Block` → an intentional cancel, same as returning `null`
 * - throws anything else → a bug: report it and pass the message through
 *   unchanged, so a broken hook can never silently drop or cancel a message.
 */
export function runMessageHook(
  hook: (message: Message) => Message | null,
  message: Message,
  onError: (error: unknown) => void,
): Message | null {
  try {
    return hook(message);
  } catch (error) {
    if (error === Block) return null;

    onError(error);
    return message;
  }
}

/**
 * A hook's result with the bytes of the frame it was given. A hook can change the event,
 * the payload and the metadata, but not the bytes, so a binary frame stays binary and a text
 * frame stays text, as on the server. `bytes` is read before the hook runs, so a hook that
 * sets `message.bytes` in place changes nothing either.
 */
export function keepFrameKind(bytes: Uint8Array | undefined, result: Message): Message {
  return result.bytes === bytes ? result : { ...result, bytes };
}

/**
 * Call every handler with the given arguments. If one handler throws, it is
 * surfaced on the socket's `error` event (via `log.report`) and the remaining
 * handlers still run. Used everywhere an event fans out to user `on()` handlers:
 * top level and channels.
 */
export function dispatchToHandlers<A extends unknown[]>(
  handlers: Iterable<(...args: A) => void> | undefined,
  log: PrimitiveLogger,
  ...args: A
): void {
  if (!handlers) return;

  const snapshot = [...handlers];
  for (const handler of snapshot) {
    try {
      handler(...args);
    } catch (error) {
      log.report(error);
    }
  }
}
