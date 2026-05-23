/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Cascade resolution for the rate-limit feature.
 *
 * At build time the implementer walks the contract tree once and turns the
 * scattered `rateLimit:` config + per-handler overrides into a flat
 * `ResolvedRateLimitPlan` keyed by scope and event. Runtime only does a map
 * lookup per frame.
 *
 * Cascade rules:
 * - No `rateLimit:` at a scope → inherit parent's rule (same bucket).
 * - `rateLimit: { enabled: true, ... }` → new rule for this scope, partial
 *   fields override parent's, missing fields fall back to parent's then
 *   built-in defaults.
 * - `rateLimit: { enabled: false }` → disabled at this scope; cascade stops.
 * - Per-event override on a scope follows the same merge rules but against
 *   the scope's resolved rule, not the parent's.
 */

import type { ChannelDef, Definition, NamespaceDef } from '~/_api/definitions.ts';
import type { ScopeDeclaration } from '~/channel/channel.ts';
import { RATE_LIMIT_DEFAULTS } from './rate-limit.ts';
import type { RateLimitConfig } from './rate-limit.ts';
import type { ResolvedRateLimitPlan, RuleInstance } from './runtime.ts';

/**
 * Per-handler overrides collected from `.rateLimit(event, config)` calls on
 * the implementer + sub-implementers. Keyed by scope key (same form as
 * `ResolvedRateLimitPlan.scopeRules`), then by event name.
 */
export type RateLimitOverrideMap = ReadonlyMap<string, ReadonlyMap<string, RateLimitConfig>>;

/**
 * Inputs collected by the implementer at build time. Pass to `resolvePlan` to
 * get the flat `ResolvedRateLimitPlan` the primitive consumes.
 */
export interface PlanInput {
  readonly contractRateLimit: RateLimitConfig | undefined;
  readonly definitions: readonly Definition[];
  readonly overrides: RateLimitOverrideMap;
}

interface RuleAllocator {
  next(): number;
}

function createAllocator(): RuleAllocator {
  let n = 0;
  return {
    next() {
      n += 1;
      return n;
    },
  };
}

function mergeRule(
  parent: RuleInstance | null,
  self: RateLimitConfig | undefined,
  alloc: RuleAllocator,
): RuleInstance | null {
  if (self === undefined) return parent;
  if (!self.enabled) return null;
  return {
    id: alloc.next(),
    windowMs: self.windowMs ?? parent?.windowMs ?? RATE_LIMIT_DEFAULTS.windowMs,
    max: self.max ?? parent?.max ?? RATE_LIMIT_DEFAULTS.max,
    per: self.per ?? parent?.per ?? RATE_LIMIT_DEFAULTS.per,
  };
}

function channelKey(pattern: string | ScopeDeclaration<string>): string {
  return typeof pattern === 'string' ? pattern : pattern.key;
}

function readChannelRateLimit(def: ChannelDef): RateLimitConfig | undefined {
  const value = (def as unknown as { rateLimit?: RateLimitConfig }).rateLimit;
  return value;
}

function readNamespaceRateLimit(def: NamespaceDef): RateLimitConfig | undefined {
  const value = (def as unknown as { rateLimit?: RateLimitConfig }).rateLimit;
  return value;
}

/**
 * Walk the contract once and compute the flat scope→rule plan.
 *
 * Returns `null` when no `rateLimit:` is set anywhere AND no per-handler
 * overrides exist — the caller should skip pushing the primitive in that
 * case so engines without the feature never pay for the intercept.
 */
export function resolvePlan(input: PlanInput): ResolvedRateLimitPlan | null {
  const alloc = createAllocator();
  const scopeRules = new Map<string, RuleInstance | null>();
  const eventOverrides = new Map<string, Map<string, RuleInstance | null>>();

  const topRule = mergeRule(null, input.contractRateLimit, alloc);
  scopeRules.set('top', topRule);

  function walk(
    defs: readonly Definition[],
    parentRule: RuleInstance | null,
    parentKey: string,
  ): void {
    for (const def of defs) {
      if (def._ === 'namespace') {
        const ns = def as NamespaceDef;
        const selfCfg = readNamespaceRateLimit(ns);
        const rule = mergeRule(parentRule, selfCfg, alloc);
        const key = parentKey === 'top' ? `ns:${ns.name}` : `${parentKey}:ns:${ns.name}`;
        scopeRules.set(key, rule);
        walk(ns.definitions, rule, key);
      } else if (def._ === 'channel') {
        const ch = def as ChannelDef;
        const selfCfg = readChannelRateLimit(ch);
        const rule = mergeRule(parentRule, selfCfg, alloc);
        const key =
          parentKey === 'top'
            ? `channel:${channelKey(ch.pattern)}`
            : `${parentKey}:channel:${channelKey(ch.pattern)}`;
        scopeRules.set(key, rule);
        walk(ch.definitions, rule, key);
      }
    }
  }

  walk(input.definitions, topRule, 'top');

  // Per-event overrides — merge against the scope's resolved rule.
  let hasAnyOverride = false;
  for (const [scopeKey, perEvent] of input.overrides) {
    const scopeRule = scopeRules.get(scopeKey) ?? null;
    const eventMap = new Map<string, RuleInstance | null>();
    for (const [event, cfg] of perEvent) {
      const rule = mergeRule(scopeRule, cfg, alloc);
      eventMap.set(event, rule);
      hasAnyOverride = true;
    }
    if (eventMap.size > 0) eventOverrides.set(scopeKey, eventMap);
  }

  // Skip the primitive entirely if no scope is enabled and no override exists.
  const anyScopeEnabled = [...scopeRules.values()].some((r) => r !== null);
  if (!anyScopeEnabled && !hasAnyOverride) return null;

  return { scopeRules, eventOverrides };
}
