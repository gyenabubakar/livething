import { withAck } from '~/ack/with.ts';
import { withDedup } from '~/dedup/with.ts';
import { withHeartbeat } from '~/heartbeat/with.ts';
import { withHibernation } from '~/hibernation/with.ts';
import { withSequence } from '~/sequence/with.ts';
import type { ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';

/**
 * Add all low-level infrastructure features to a server builder in one call:
 * ack, dedup, heartbeat, sequence, and hibernation.
 *
 * This is a convenience wrapper — you can also add each feature individually
 * with `withAck`, `withDedup`, `withHeartbeat`, `withSequence`, and `withHibernation`.
 */
export function withInfrastructure<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<
  TState,
  TFeatures & { ack: true; dedup: true; heartbeat: true; sequence: true; hibernation: true }
> {
  return withHibernation(withHeartbeat(withSequence(withDedup(withAck(builder)))));
}
