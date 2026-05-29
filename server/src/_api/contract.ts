/* oxlint-disable @typescript-eslint/no-explicit-any */

import { assertValidWSKitIdentifier } from '@wskit/core';
import { collectUnique } from '~/_engine/compile/utils.ts';
import {
  assertOneOf,
  assertOptionalPositiveInteger,
  assertPositiveInteger,
} from '~/_engine/validation.ts';
import { resolveTagGroupDefs } from '~/tags/tags.ts';
import type { Contract, ContractConfig, EnvFromConfig } from './contract-types.ts';

function validateTagDefs(tags: ContractConfig['tags']): void {
  if (!tags) return;
  const seen = { ephemeral: new Set<string>(), persistent: new Set<string>() };
  for (const def of resolveTagGroupDefs(tags)) {
    assertValidWSKitIdentifier(def.name, `contract(): ${def.kind} tag group name`);
    if (seen[def.kind].has(def.name)) {
      throw new Error(`[wskit] contract(): ${def.kind} tag group '${def.name}' is declared twice.`);
    }
    seen[def.kind].add(def.name);
  }
}

function validateContractConfig(config: ContractConfig): void {
  if (config.heartbeat) {
    const opts =
      typeof config.heartbeat === 'object'
        ? config.heartbeat
        : ({} as { intervalMs?: number; timeoutMs?: number });
    const timeout = opts.timeoutMs ?? opts.intervalMs ?? 30_000;
    assertPositiveInteger(timeout, 'heartbeat.timeoutMs', 'contract()');
  }

  if (typeof config.sequence === 'object' && config.sequence !== null) {
    assertOptionalPositiveInteger(config.sequence.batchSize, 'batchSize', 'sequence()');
  }

  if (typeof config.dedup === 'object' && config.dedup !== null) {
    assertOptionalPositiveInteger(config.dedup.cap, 'cap', 'dedup()');
  }

  if (typeof config.replay === 'object' && config.replay !== null) {
    const replay = config.replay;
    assertOptionalPositiveInteger(replay.retention?.maxAgeMs, 'retention.maxAgeMs', 'replay()');
    assertOptionalPositiveInteger(
      replay.retention?.maxMessages,
      'retention.maxMessages',
      'replay()',
    );
    if (replay.durability !== undefined) {
      assertOneOf(replay.durability, ['strict', 'best-effort'] as const, {
        field: 'durability',
        context: 'replay()',
      });
    }
    if (replay.type !== undefined) {
      assertOneOf(replay.type, ['history', 'snapshot'] as const, {
        field: 'type',
        context: 'replay()',
      });
    }
  }

  if (config.errors && config.errors.length > 0) {
    collectUnique(config.errors as readonly { code: string }[], (e) => e.code, {
      kind: 'error code',
      context: 'contract()',
    });
  }

  validateTagDefs(config.tags);
}

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
  validateContractConfig(config);
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
