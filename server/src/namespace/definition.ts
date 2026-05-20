/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { NamespaceDefinition } from '~/_api/definitions.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';

/**
 * Contract-side declaration of a namespace — a grouping of events under a
 * shared prefix. Produced by `namespace()`. Channels and nested namespaces
 * are not allowed inside; declare them at the top level instead.
 */
export interface NamespaceDef<
  TName extends string = string,
  TDefinitions extends readonly NamespaceDefinition[] = readonly NamespaceDefinition[],
> {
  readonly _: 'namespace';
  readonly name: TName;
  readonly rateLimit?: RateLimitConfig;
  readonly definitions: TDefinitions;
}

/**
 * Declare a namespace — a grouping of events under a shared prefix.
 *
 * Allowed children: `incoming`, `outgoing`, `request`, `stream`,
 * `resumableStream`, `recordedStream`, `scheduled`. Channels and nested
 * namespaces are rejected at the type level and at build time.
 */
export function namespace<
  TName extends string,
  const TDefinitions extends readonly NamespaceDefinition[],
>(
  name: TName,
  config: { rateLimit?: RateLimitConfig; definitions: TDefinitions },
): NamespaceDef<TName, TDefinitions> {
  return {
    _: 'namespace',
    name,
    rateLimit: config.rateLimit,
    definitions: config.definitions,
  };
}
