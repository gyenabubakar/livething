/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Definition } from '~/_api/definitions.ts';
import type { ScopeDeclaration } from '~/channel/channel.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';
import type { Validator } from '~/types.ts';

/**
 * Contract-side declaration of a channel — a pub/sub group with its own
 * incoming/outgoing events. Produced by `channel()`. Use a string for static
 * channels or `scope()` for dynamic patterns.
 */
export interface ChannelDef<
  TPattern extends string | ScopeDeclaration<string> = string | ScopeDeclaration<string>,
  TDefinitions extends readonly Definition[] = readonly Definition[],
  TCheckPayload = unknown,
> {
  readonly _: 'channel';
  readonly pattern: TPattern;
  readonly persistent?: boolean;
  readonly replay?: unknown;
  readonly rateLimit?: RateLimitConfig;
  readonly definitions: TDefinitions;
  /** Validator for the subscribe payload passed to the channel's `check` handler. */
  readonly checkValidator?: Validator<TCheckPayload>;
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
 *
 * Pass `check` to validate the payload a client sends when subscribing to this
 * channel. The validated payload is available as the second argument of the
 * `check` handler in the implementation, and as `subscribePayload` in
 * `InferClient`.
 */
export function channel<TPattern extends string, const TDefinitions extends readonly Definition[]>(
  pattern: TPattern,
  config: ChannelConfig<TDefinitions>,
): ChannelDef<TPattern, TDefinitions, unknown>;
export function channel<
  TPattern extends string,
  const TDefinitions extends readonly Definition[],
  TSchema extends StandardSchemaV1,
>(
  pattern: TPattern,
  config: ChannelConfig<TDefinitions> & { check: TSchema },
): ChannelDef<TPattern, TDefinitions, StandardSchemaV1.InferOutput<TSchema>>;
export function channel<
  TPattern extends string,
  const TDefinitions extends readonly Definition[],
  TCheckPayload,
>(
  pattern: TPattern,
  config: ChannelConfig<TDefinitions> & { check: Validator<TCheckPayload> },
): ChannelDef<TPattern, TDefinitions, TCheckPayload>;
export function channel<
  TDecl extends ScopeDeclaration<string, any>,
  const TDefinitions extends readonly Definition[],
>(pattern: TDecl, config: ChannelConfig<TDefinitions>): ChannelDef<TDecl, TDefinitions, unknown>;
export function channel<
  TDecl extends ScopeDeclaration<string, any>,
  const TDefinitions extends readonly Definition[],
  TSchema extends StandardSchemaV1,
>(
  pattern: TDecl,
  config: ChannelConfig<TDefinitions> & { check: TSchema },
): ChannelDef<TDecl, TDefinitions, StandardSchemaV1.InferOutput<TSchema>>;
export function channel<
  TDecl extends ScopeDeclaration<string, any>,
  const TDefinitions extends readonly Definition[],
  TCheckPayload,
>(
  pattern: TDecl,
  config: ChannelConfig<TDefinitions> & { check: Validator<TCheckPayload> },
): ChannelDef<TDecl, TDefinitions, TCheckPayload>;
export function channel(
  pattern: string | ScopeDeclaration<string>,
  config: ChannelConfig<readonly Definition[]> & { check?: Validator },
): ChannelDef {
  return {
    _: 'channel',
    pattern,
    persistent: config.persistent,
    replay: config.replay,
    rateLimit: config.rateLimit,
    definitions: config.definitions,
    checkValidator: config.check,
  };
}
