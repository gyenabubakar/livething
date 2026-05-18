/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Definition } from '~/_api/definitions.ts';

/**
 * Contract-side declaration of a namespace — a grouping of events under a
 * shared prefix. Produced by `namespace()`.
 */
export interface NamespaceDef<
  TName extends string = string,
  TDefinitions extends readonly Definition[] = readonly Definition[],
> {
  readonly _: 'namespace';
  readonly name: TName;
  readonly definitions: TDefinitions;
}

/**
 * Declare a namespace — a grouping of events under a shared prefix.
 */
export function namespace<TName extends string, const TDefinitions extends readonly Definition[]>(
  name: TName,
  config: { definitions: TDefinitions },
): NamespaceDef<TName, TDefinitions> {
  return { _: 'namespace', name, definitions: config.definitions };
}
