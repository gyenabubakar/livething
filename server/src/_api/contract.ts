/* oxlint-disable @typescript-eslint/no-explicit-any */

import type { Contract, ContractConfig, EnvFromConfig } from './contract-types.ts';

/**
 * Create a wskit contract — the declarative half of a server.
 *
 * Every type is inferred from the config object — no explicit generic
 * arguments at the call site. Mark the env shape with `env: t<Env>()` (same
 * TypeMarker pattern used for `meta`) so TS pulls it back out. With nothing
 * supplied explicitly, TS can infer the const-narrowed TConfig together with
 * TEnv; an explicit generic argument would cut off inference for the others.
 *
 * @example
 * ```ts
 * import { contract, incoming, outgoing, channel, t } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * export const chatContract = contract('chat', {
 *   env: t<Env>(),
 *   ack: true,
 *   persistence: true,
 *   meta: t<{ username: string }>(),
 *   definitions: [
 *     incoming('send-msg', v.object({ text: v.string() })),
 *     outgoing('msg', v.object({ text: v.string() })),
 *   ],
 * });
 * ```
 */
export function contract<const TConfig extends ContractConfig = ContractConfig>(
  name: string,
  config: TConfig,
): Contract<TConfig, EnvFromConfig<TConfig>> {
  return Object.freeze({
    __wskit_contract: true as const,
    __config: config,
    name,
    incoming: undefined as any,
    outgoing: undefined as any,
    requests: undefined as any,
    streams: undefined as any,
    resumableStreams: undefined as any,
    recordedStreams: undefined as any,
    channels: undefined as any,
    namespaces: undefined as any,
    scheduled: undefined as any,
    errors: undefined as any,
    features: undefined as any,
    meta: undefined as any,
    env: undefined as any,
    tagGroups: undefined as any,
    definitions: config.definitions,
  }) as unknown as Contract<TConfig, EnvFromConfig<TConfig>>;
}
