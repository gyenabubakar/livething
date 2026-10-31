import { LiveThingConfigError } from '@livething/core';
import { capabilityDisplayName } from '~/_define/capability-kinds.ts';
import type { AnyCapability } from '~/_define/capability.ts';

/** The options one config object takes, for callers the types can't protect. */
export interface ConfigShape {
  readonly hooks: readonly string[];
  readonly options: readonly string[];
}

/** Refuse an unknown key, and a hook that isn't a function. A silent one could drop an auth gate. */
export function assertConfigShape(config: object, shape: ConfigShape, context: string): void {
  const { hooks, options } = shape;
  for (const [key, value] of Object.entries(config)) {
    if (!hooks.includes(key) && !options.includes(key)) {
      throw new LiveThingConfigError(
        `${context}: unknown option '${key}'. Check its spelling. ` +
          `The options are: ${[...hooks, ...options].join(', ')}.`,
      );
    }

    if (value !== undefined && hooks.includes(key) && typeof value !== 'function') {
      throw new LiveThingConfigError(`${context}: '${key}' must be a function.`);
    }
  }
}

export function assertUniqueCapabilityKinds(
  capabilities: readonly AnyCapability[],
  context: string,
): void {
  const seen = new Set<string>();

  for (const capability of capabilities) {
    const kind = capability.__capabilityKind;
    if (!kind) continue;

    if (seen.has(kind)) {
      throw new LiveThingConfigError(
        `${capabilityDisplayName(kind)} is listed more than once in ${context}. ` +
          'Each capability can be listed once per scope.',
      );
    }

    seen.add(kind);
  }
}
