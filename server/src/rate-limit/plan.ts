/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Cascade resolution for the rate-limit feature.
 *
 * At assembly time the definition compiler walks the selected primitive tree once and turns the
 * scattered `rateLimit:` config + per-handler overrides into a flat
 * `ResolvedRateLimitPlan` keyed by scope and event. Runtime only does a map
 * lookup per frame.
 *
 * Cascade rules:
 * - No `rateLimit:` at a scope → inherit parent's rule (same bucket).
 * - `rateLimit: { ... }` → new rule for this scope, partial fields override
 *   parent's, missing fields fall back to parent's then built-in defaults.
 * - `rateLimit: false` → disabled at this scope; cascade stops.
 * - Per-event override on a scope follows the same merge rules but against
 *   the scope's resolved rule, not the parent's.
 */

import { assertPositiveInteger } from '~/_engine/validation.ts';
import { RATE_LIMIT_DEFAULTS } from './rate-limit.ts';
import type { RateLimitConfig } from './rate-limit.ts';
import type { ResolvedRateLimitPlan, RuleInstance } from './runtime.ts';

/**
 * Per-handler overrides collected from handler config during assembly. Keyed by scope key (same form as
 * `ResolvedRateLimitPlan.scopeRules`), then by event name.
 */
type RateLimitOverrideMap = ReadonlyMap<string, ReadonlyMap<string, RateLimitConfig>>;

/** One channel scope: its key (the family key for a dynamic channel) and its own rule, if any. */
interface PlanChannel {
  readonly key: string;
  readonly rateLimit?: RateLimitConfig;
}

/**
 * Inputs collected by the definition compiler at assembly time. Pass to `resolvePlan` to
 * get the flat `ResolvedRateLimitPlan` the primitive consumes.
 */
export interface PlanInput {
  readonly contractRateLimit: RateLimitConfig | undefined;
  readonly channels: readonly PlanChannel[];
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

interface MergeRuleOptions {
  parent: RuleInstance | null;
  self: RateLimitConfig | undefined;
  alloc: RuleAllocator;
  context: string;
}

function mergeRule(opts: MergeRuleOptions): RuleInstance | null {
  const { parent, self, alloc, context } = opts;
  if (self === undefined) return parent;

  if (self === false) return null;

  const windowMs = self.windowMs ?? parent?.windowMs ?? RATE_LIMIT_DEFAULTS.windowMs;
  const maxMessages = self.maxMessages ?? parent?.maxMessages ?? RATE_LIMIT_DEFAULTS.maxMessages;
  const maxBytes = self.maxBytes ?? parent?.maxBytes;

  assertPositiveInteger(windowMs, 'windowMs', `rateLimit at ${context}`);
  assertPositiveInteger(maxMessages, 'maxMessages', `rateLimit at ${context}`);
  if (maxBytes !== undefined)
    assertPositiveInteger(maxBytes, 'maxBytes', `rateLimit at ${context}`);

  return {
    id: alloc.next(),
    windowMs,
    maxMessages,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    per: self.per ?? parent?.per ?? RATE_LIMIT_DEFAULTS.per,
  };
}

/**
 * Compute the flat scope→rule plan.
 *
 * Returns `null` when no `rateLimit:` is set anywhere AND no per-handler
 * overrides exist — the caller should skip pushing the primitive in that
 * case so engines without the feature never pay for the intercept.
 */
export function resolvePlan(input: PlanInput): ResolvedRateLimitPlan | null {
  const alloc = createAllocator();
  const scopeRules = new Map<string, RuleInstance | null>();
  const eventOverrides = new Map<string, Map<string, RuleInstance | null>>();

  const topRule = mergeRule({
    parent: null,
    self: input.contractRateLimit,
    alloc,
    context: 'top-level',
  });
  scopeRules.set('top', topRule);

  for (const channel of input.channels) {
    scopeRules.set(
      `channel:${channel.key}`,
      mergeRule({
        parent: topRule,
        self: channel.rateLimit,
        alloc,
        context: `channel "${channel.key}"`,
      }),
    );
  }

  // Per-event overrides — merge against the scope's resolved rule.
  let hasAnyOverride = false;
  for (const [scopeKey, perEvent] of input.overrides) {
    const scopeRule = scopeRules.get(scopeKey) ?? null;
    const eventMap = new Map<string, RuleInstance | null>();
    for (const [event, cfg] of perEvent) {
      const rule = mergeRule({
        parent: scopeRule,
        self: cfg,
        alloc,
        context: `event "${event}" at scope "${scopeKey}"`,
      });
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
