/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Definition } from '~/_api/definitions.ts';
import type { ScopeDeclaration } from '~/channel/channel.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';

/**
 * Contract-side declaration of a channel — a pub/sub group with its own
 * incoming/outgoing events. Produced by `channel()`. Use a string for static
 * channels or `scope()` for dynamic patterns.
 */
export interface ChannelDef<
  TPattern extends string | ScopeDeclaration<string> = string | ScopeDeclaration<string>,
  TDefinitions extends readonly Definition[] = readonly Definition[],
> {
  readonly _: 'channel';
  readonly pattern: TPattern;
  readonly persistent?: boolean;
  readonly replay?: unknown;
  readonly rateLimit?: RateLimitConfig;
  readonly definitions: TDefinitions;
}

interface ChannelConfig<TDefinitions extends readonly Definition[]> {
  persistent?: boolean;
  replay?: unknown;
  rateLimit?: RateLimitConfig;
  definitions: TDefinitions;
}

/**
 * Declare a channel — a pub/sub group with its own incoming/outgoing events.
 * Use a string for static channels or `scope()` for dynamic patterns.
 */
export function channel<TPattern extends string, const TDefinitions extends readonly Definition[]>(
  pattern: TPattern,
  config: ChannelConfig<TDefinitions>,
): ChannelDef<TPattern, TDefinitions>;
export function channel<TKey extends string, const TDefinitions extends readonly Definition[]>(
  pattern: ScopeDeclaration<TKey>,
  config: ChannelConfig<TDefinitions>,
): ChannelDef<ScopeDeclaration<TKey>, TDefinitions>;
export function channel(
  pattern: string | ScopeDeclaration<string>,
  config: ChannelConfig<readonly Definition[]>,
): ChannelDef {
  return {
    _: 'channel',
    pattern,
    persistent: config.persistent,
    replay: config.replay,
    rateLimit: config.rateLimit,
    definitions: config.definitions,
  };
}
