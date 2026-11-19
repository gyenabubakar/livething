/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertSynchronousResult, LiveThingConfigError, ValidationFailed } from '@livething/core';
import { isStandardSchema } from '~/_engine/validation.ts';
import type * as ChannelPrimitive from '~/channel/channel.ts';
import type * as PrimitiveCore from '~/primitive.ts';

type ValidateValueNormalizedValue = { message: string; path?: Array<string | number> };

interface DeclarationLocation {
  kind: string;
  context: string;
}

interface UniqueEntry<V> {
  value: V;
  kind: string;
}

/**
 * Walk a list once and throw if any two items share the same key. Use this
 * before any `Map.set`/`Set.add`/object-key write loop — those collapse
 * duplicates silently and let the second declaration win without any signal.
 * The thrown `LiveThingConfigError` names the kind and the duplicated key so the
 * misconfiguration is obvious at boot.
 */
export function collectUnique<T>(
  items: readonly T[],
  keyFn: (item: T) => string,
  where: DeclarationLocation,
): readonly T[] {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      throw new LiveThingConfigError(
        `${where.context}: duplicate ${where.kind} "${key}". Each name can only be declared once per scope.`,
      );
    }

    seen.add(key);
  }

  return items;
}

/**
 * Insert into a compile-time map and throw if the key already exists. Each
 * primitive kind (incoming, outgoing, request, stream variants, scheduled,
 * channel) owns its own slot on `CompiledServer`, and without this check a
 * duplicate declaration in the same slot would silently overwrite the first.
 * With this helper, a duplicate fails build with a clear `LiveThingConfigError`
 * so the engine refuses to construct and the server doesn't start with a
 * half-broken contract.
 */
export function setUniqueOrThrow<V>(map: Map<string, V>, key: string, entry: UniqueEntry<V>): void {
  if (map.has(key)) {
    throw new LiveThingConfigError(
      `Duplicate ${entry.kind} declaration for "${key}". ` +
        `Each name can only be declared once per scope.`,
    );
  }

  map.set(key, entry.value);
}

/**
 * Narrow a primitive to a channel block.
 */
export function isChannelPrimitive(
  primitive: PrimitiveCore.Primitive,
): primitive is ChannelPrimitive.ChannelPrimitive {
  return primitive.__livething === 'channel';
}

/**
 * Merge primitive dependency requirements into one runtime manifest.
 */
export function mergeRequires(
  target: PrimitiveCore.RequiresManifest,
  source: PrimitiveCore.RequiresManifest,
): void {
  if (source.hibernation) target.hibernation = true;
}

/**
 * Validate a value against a Standard Schema and return the parsed result.
 * A missing validator passes the value through unchanged.
 */
export function validateValue(validator: unknown, value: unknown, event = 'unknown'): unknown {
  if (!validator) return value;

  if (isStandardSchema(validator)) {
    const result = assertSynchronousResult(
      validator['~standard'].validate(value),
      event,
      'validator',
    );

    if (result && typeof result === 'object' && 'issues' in result) {
      const rawIssues = (result as { issues: Array<{ message: string; path?: unknown[] }> }).issues;
      throw ValidationFailed({
        event,
        issues: rawIssues.map((issue) => {
          const normalized: ValidateValueNormalizedValue = {
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
