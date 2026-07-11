/*
 * A plugin owns a namespace. Every one of its names travels on the wire as
 * `__<id>::<name>` — two underscores, the plugin id, two colons, then the plain
 * name. The id itself may hold a single colon (`acme:chat`), so the split looks
 * for the first `::`, which always sits between the id and the name.
 */

/** The marker between a plugin id and a name on the wire. */
export const NAMESPACE_DELIMITER = '::';

/** Build the wire name for a plugin's event, request, or channel. */
export function namespacedName(id: string, name: string): string {
  return `__${id}${NAMESPACE_DELIMITER}${name}`;
}

/**
 * Split a wire name back into its plugin id and plain name, or `null` if it isn't
 * a plugin name. A plain event, a bare protocol frame like `__error__`, and a
 * name with no `::` all return `null`.
 */
export function parseNamespaced(event: string): { id: string; name: string } | null {
  if (!event.startsWith('__')) return null;
  const at = event.indexOf(NAMESPACE_DELIMITER);
  if (at < 0) return null;
  return { id: event.slice(2, at), name: event.slice(at + NAMESPACE_DELIMITER.length) };
}
