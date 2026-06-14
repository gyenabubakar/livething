/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * The delimiter between a plugin id and a short name on the wire. A plugin's
 * event `heartbeat` under plugin `acme:presence` travels as
 * `__acme:presence::heartbeat`. `::` is framework-reserved (it also marks
 * channel scope in addressing), so it can never appear in a user-declared name —
 * which makes the id↔name split unambiguous (split once on `::`).
 */
const PLUGIN_NS_DELIM = '::';

/** Build the wire name for a plugin-owned event: `__<id>::<name>`. */
export function pluginWireName(id: string, name: string): string {
  return `__${id}${PLUGIN_NS_DELIM}${name}`;
}

/** The send-like context methods whose event argument a plugin scope rewrites. */
type SendPosition = 'event-first' | 'event-second';
const SCOPED_SENDS: Record<string, SendPosition> = {
  send: 'event-first',
  broadcast: 'event-first',
  sendToConnection: 'event-second',
};

/**
 * Wrap a handler context so its send-like methods prefix the event name with
 * the plugin's namespace. A plugin handler (or its `api`) writes
 * `ctx.send('user-online', ...)` and the client receives `__<id>::user-online`,
 * matching the namespaced `emits(...)` declaration.
 */
export function scopePluginContext(id: string, ctx: any): any {
  return new Proxy(ctx as Record<PropertyKey, unknown>, {
    get(target, key, receiver) {
      const position = typeof key === 'string' ? SCOPED_SENDS[key] : undefined;
      if (!position) return Reflect.get(target, key, receiver);
      const original = Reflect.get(target, key, receiver) as (...args: unknown[]) => unknown;
      if (position === 'event-first') {
        return (event: unknown, ...rest: unknown[]) =>
          original(pluginWireName(id, event as string), ...rest);
      }
      return (first: unknown, event: unknown, ...rest: unknown[]) =>
        original(first, pluginWireName(id, event as string), ...rest);
    },
  });
}
