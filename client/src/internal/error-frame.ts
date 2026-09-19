import { LiveThingError } from '@livething/core';
import { namespacePrefixOf } from '~/internal/namespace.ts';

/** Turn an `__error__` frame's `{ code, detail? }` payload into a `LiveThingError`. */
export function toLiveThingError(payload: unknown): LiveThingError {
  const fields = (payload ?? {}) as { code?: unknown; detail?: unknown };
  const code = typeof fields.code === 'string' ? fields.code : 'internal-error';
  return new LiveThingError(code, fields.detail);
}

/**
 * Strip a plugin's namespace off an error's code so the plugin author sees the
 * plain name they declared. A server-sent error for a plugin carries the
 * namespaced wire code (`__<id>::room-full`), and a request/stream/channel reply
 * is claimed by its primitive before the plugin can restrip it — so we strip
 * here, using the prefix of the operation's own namespaced name (`source`: a
 * request/stream event, or a channel's name / family key). A non-namespaced
 * source (a plain app operation), a non-`LiveThingError`, or a code from a different
 * namespace (e.g. a built-in) is returned untouched — mirroring the scoped
 * `onServerError` path so both directions of a plugin's errors read in plain names.
 */
export function unscopeErrorCode(source: string | undefined, error: unknown): unknown {
  if (source === undefined || !(error instanceof LiveThingError)) return error;

  const prefix = namespacePrefixOf(source);
  return prefix && error.code.startsWith(prefix)
    ? new LiveThingError(error.code.slice(prefix.length), error.detail)
    : error;
}
