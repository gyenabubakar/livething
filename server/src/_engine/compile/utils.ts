/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  assertSyncResult,
  assertValidWSKitIdentifier,
  ValidationFailed,
  WskitConfigError,
} from '@wskit/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type * as ChannelPrimitive from '~/channel/channel.ts';
import type * as NamespacePrimitive from '~/namespace/namespace.ts';
import type * as PrimitiveCore from '~/primitive.ts';

/**
 * Throw at declaration time if an event name clashes with the wskit wire
 * protocol. `ping`/`pong` are the raw heartbeat frames; the `__` prefix is
 * reserved for protocol events (`__subscribe__`, `__error__`, ...) and
 * plugin-owned events. Called by every definition factory that takes an event
 * name.
 */
/**
 * Insert into a compile-time map and throw if the key already exists. Each
 * primitive kind (incoming, outgoing, request, stream variants, scheduled,
 * channel, namespace) owns its own slot on `CompiledServer`, and a duplicate
 * declaration in the same slot was previously silent — the second declaration
 * just overwrote the first. With this helper, a duplicate fails build with a
 * clear `WskitConfigError` so the engine refuses to construct and the server
 * doesn't start with a half-broken contract.
 */
/**
 * Walk a list once and throw if any two items share the same key. Use this
 * before any `Map.set`/`Set.add`/object-key write loop — those collapse
 * duplicates silently and let the second declaration win without any signal.
 * The thrown `WskitConfigError` names the kind and the duplicated key so the
 * misconfiguration is obvious at boot.
 */
export function collectUnique<T>(
  items: readonly T[],
  keyFn: (item: T) => string,
  where: { kind: string; context: string },
): readonly T[] {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      throw new WskitConfigError(
        `[wskit] ${where.context}: duplicate ${where.kind} "${key}". Each name can only be declared once per scope.`,
      );
    }
    seen.add(key);
  }
  return items;
}

export function setUniqueOrThrow<V>(
  map: Map<string, V>,
  key: string,
  entry: { value: V; kind: string },
): void {
  if (map.has(key)) {
    throw new WskitConfigError(
      `[wskit] Duplicate ${entry.kind} declaration for "${key}". ` +
        `Each name can only be declared once per scope.`,
    );
  }
  map.set(key, entry.value);
}

export function assertNonReservedEventName(name: string, factory: string): void {
  assertValidWSKitIdentifier(name, `${factory}() event name`);
  if (name === 'ping' || name === 'pong') {
    throw new Error(
      `[wskit] '${name}' is a reserved heartbeat frame name. Pick a different name for ${factory}().`,
    );
  }
}

/**
 * Narrow a primitive to a namespace block.
 */
export function isNamespacePrimitive(
  primitive: PrimitiveCore.Primitive,
): primitive is NamespacePrimitive.NamespacePrimitive {
  return primitive.__wskit === 'namespace';
}

/**
 * Narrow a primitive to a channel block.
 */
export function isChannelPrimitive(
  primitive: PrimitiveCore.Primitive,
): primitive is ChannelPrimitive.ChannelPrimitive {
  return primitive.__wskit === 'channel';
}

/**
 * Merge primitive dependency requirements into one runtime manifest.
 */
export function mergeRequires(
  target: PrimitiveCore.RequiresManifest,
  source: PrimitiveCore.RequiresManifest,
): void {
  if (source.storage) target.storage = true;
  if (source.timers) target.timers = true;
  if (source.hibernation) target.hibernation = true;
}

function isStandardSchema(v: unknown): v is StandardSchemaV1 {
  return (
    !!v &&
    typeof v === 'object' &&
    '~standard' in v &&
    typeof (v as Record<string, any>)['~standard']?.validate === 'function'
  );
}

/**
 * Validate a value against a Standard Schema and return the parsed result.
 * A missing validator passes the value through unchanged.
 */
export function validateValue(validator: unknown, value: unknown, event = 'unknown'): unknown {
  if (!validator) return value;

  if (isStandardSchema(validator)) {
    const result = assertSyncResult(validator['~standard'].validate(value), event);

    if (result && typeof result === 'object' && 'issues' in result) {
      const rawIssues = (result as { issues: Array<{ message: string; path?: unknown[] }> }).issues;
      throw ValidationFailed({
        event,
        issues: rawIssues.map((issue) => {
          const normalized: { message: string; path?: Array<string | number> } = {
            message: issue.message,
          };
          if (Array.isArray(issue.path)) {
            const pathKeys = issue.path.flatMap((p) => {
              if (typeof p === 'string' || typeof p === 'number') return [p];
              if (p && typeof p === 'object' && 'key' in (p as object)) {
                const k = (p as { key: unknown }).key;
                if (typeof k === 'string' || typeof k === 'number') return [k];
              }
              return [];
            });
            if (pathKeys.length > 0) normalized.path = pathKeys;
          }
          return normalized;
        }),
      });
    }

    if (result && typeof result === 'object' && 'value' in result) {
      return (result as { value: unknown }).value;
    }

    return result;
  }

  return value;
}

/**
 * Build the private wire event name for a plugin-owned event.
 */
export function prefixedPluginEvent(pluginId: string, event: string): string {
  return `__${pluginId}:${event}`;
}
