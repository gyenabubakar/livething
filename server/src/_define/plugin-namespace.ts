/* oxlint-disable @typescript-eslint/no-explicit-any */
import { pluginWireName, scopePluginContext } from '~/plugin-scope.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive kinds that route or declare by a plain `event` field. */
const EVENT_KINDS = new Set(['incoming', 'request', 'outgoing']);

/** Rewrite one routable primitive into its namespaced form for plugin `id`. */
function namespaceOne(id: string, primitive: Primitive): Primitive {
  if (!EVENT_KINDS.has(primitive.__wskit)) return primitive;
  const event = (primitive as { event?: string }).event;
  if (event === undefined) return primitive;

  const wireEvent = pluginWireName(id, event);
  const [key] = primitive.__identity;
  const copy: Record<PropertyKey, unknown> = {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    event: wireEvent,
    __identity: [key, wireEvent],
    // Provenance marker: this event is framework-namespaced for a plugin, so the
    // compile-time reserved-name guards allow its `__`/`::` form. A user-declared
    // event never carries this, so it can't slip a reserved name past the guards.
    __plugin: id,
  };

  const handler = (primitive as { handler?: (ctx: any, payload: any) => unknown }).handler;
  if (handler) {
    copy.handler = (ctx: any, payload: any) => handler(scopePluginContext(id, ctx), payload);
  }
  return copy as unknown as Primitive;
}

/**
 * Namespace every routable primitive a plugin contributes so its events,
 * requests, and emits live under `__<id>::` and can't collide with the host's
 * or another plugin's. Non-routable primitives pass through untouched.
 */
export function namespacePluginPrimitives(
  id: string,
  primitives: readonly Primitive[],
): Primitive[] {
  return primitives.map((primitive) => namespaceOne(id, primitive));
}
