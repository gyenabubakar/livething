/*
 * A plugin owns a namespace. Every one of its names travels on the wire as
 * `__<id>::<name>` — two underscores, the plugin id, two colons, then the plain
 * name. A plugin matches its own frames by this exact prefix, so the id may be
 * anything: a namespaced `acme:chat` or a bare `feed`.
 */

/** The marker between a plugin id and a name on the wire. */
export const NAMESPACE_DELIMITER = '::';

/** Build the wire name for a plugin's event, request, or channel. */
export function namespacedName(id: string, name: string): string {
  return `__${id}${NAMESPACE_DELIMITER}${name}`;
}
