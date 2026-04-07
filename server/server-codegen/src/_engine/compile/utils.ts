/* oxlint-disable @typescript-eslint/no-explicit-any */
import { ValidationFailed } from '@wskit/core';
import type { ChannelPrimitive } from '~/channel/index.ts';
import type { NamespacePrimitive } from '~/namespace/index.ts';
import type { PassivePrimitive } from '~/passive/index.ts';
import type { Primitive, RequiresManifest } from '~/primitive.ts';

/**
 * Runtime-only wrapper primitives are unwrapped during compilation.
 */
export function isPassivePrimitive(primitive: Primitive): primitive is PassivePrimitive<any> {
  return primitive.__wskit === 'passive';
}

/**
 * Narrow a primitive to a namespace block.
 */
export function isNamespacePrimitive(primitive: Primitive): primitive is NamespacePrimitive {
  return primitive.__wskit === 'namespace';
}

/**
 * Narrow a primitive to a channel block.
 */
export function isChannelPrimitive(primitive: Primitive): primitive is ChannelPrimitive {
  return primitive.__wskit === 'channel';
}

/**
 * Merge primitive dependency requirements into one runtime manifest.
 */
export function mergeRequires(target: RequiresManifest, source: RequiresManifest): void {
  if (source.storage) target.storage = true;
  if (source.timers) target.timers = true;
  if (source.hibernation) target.hibernation = true;
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
    return validator(value);
  }

  if (
    validator &&
    typeof validator === 'object' &&
    '~standard' in (validator as object) &&
    typeof (validator as { '~standard'?: { validate?: (value: unknown) => unknown } })['~standard']
      ?.validate === 'function'
  ) {
    const result = (validator as { '~standard': { validate(value: unknown): unknown } })[
      '~standard'
    ].validate(value);

    if (result && typeof result === 'object' && 'issues' in (result as object)) {
      throw ValidationFailed({
        event,
        issues: (result as { issues: { message: string; path?: (string | number)[] }[] }).issues,
      });
    }

    if (result && typeof result === 'object' && 'value' in (result as object)) {
      return (result as { value: unknown }).value;
    }

    return result;
  }

  return value;
}

/**
 * Reserve a private wire event name for a module-owned event.
 */
export function prefixedModuleEvent(moduleId: string, event: string): string {
  return `__${moduleId}:${event}`;
}
