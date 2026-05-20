/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertSyncResult, ValidationFailed } from '@wskit/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type * as ChannelPrimitive from '~/channel/channel.ts';
import type * as NamespacePrimitive from '~/namespace/namespace.ts';
import type * as PrimitiveCore from '~/primitive.ts';

/**
 * Throw at declaration time if an event name clashes with the wskit wire
 * protocol. `ping`/`pong` are the raw heartbeat frames; the `__` prefix is
 * reserved for protocol events (`__subscribe__`, `__error__`, ...) and
 * module-owned events. Called by every definition factory that takes an event
 * name.
 */
export function assertNonReservedEventName(name: string, factory: string): void {
  if (name === 'ping' || name === 'pong') {
    throw new Error(
      `[wskit] '${name}' is a reserved heartbeat frame name. Pick a different name for ${factory}().`,
    );
  }
  if (name.startsWith('__')) {
    throw new Error(
      `[wskit] '${name}' starts with the reserved double-underscore prefix. ` +
        `That prefix is reserved for wskit protocol and module events. Pick a different name for ${factory}().`,
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
 * Run a validator or standard-schema object and normalize the result.
 *
 * This lets the engine accept plain validator functions and schema libraries
 * that expose the Standard Schema interface.
 */
export function validateValue(validator: unknown, value: unknown, event = 'unknown'): unknown {
  if (!validator) return value;

  if (typeof validator === 'function') {
    return assertSyncResult(validator(value), event);
  }

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
 * Build the private wire event name for a module-owned event.
 */
export function prefixedModuleEvent(moduleId: string, event: string): string {
  return `__${moduleId}:${event}`;
}
