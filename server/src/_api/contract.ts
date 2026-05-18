/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Top-level `contract()` factory. Holds declarative state (events, channels,
 * features, tag groups) but no handlers. Pair it with `implement(contract)` to
 * attach behaviour.
 *
 * Curried so the env generic and the config inference don't fight each other:
 * `contract<Env>('name')({ ... })`.
 */

import type { Contract, ContractConfig } from './contract-types.ts';

interface ContractFactory<TEnv extends object> {
  <const TConfig>(config: TConfig & ContractConfig): Contract<TConfig, TEnv>;
}

/**
 * Create a wskit contract — the declarative half of a server.
 *
 * @example
 * ```ts
 * import { contract, incoming, outgoing, channel, t } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * export const chatContract = contract<Env>('chat')({
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
export function contract<TEnv extends object = Record<string, unknown>>(
  name: string,
): ContractFactory<TEnv> {
  return ((config: ContractConfig) =>
    Object.freeze({
      __wskit_contract: true as const,
      __config: config,
      name,
      incoming: undefined as any,
      outgoing: undefined as any,
      requests: undefined as any,
      streams: undefined as any,
      channels: undefined as any,
      namespaces: undefined as any,
      scheduled: undefined as any,
      errors: undefined as any,
      features: undefined as any,
      meta: undefined as any,
      env: undefined as any,
      tagGroups: undefined as any,
      definitions: config.definitions,
    })) as unknown as ContractFactory<TEnv>;
}
