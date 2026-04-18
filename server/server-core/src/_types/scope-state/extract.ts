/* oxlint-disable @typescript-eslint/no-explicit-any */

import type { ScopeStateShape } from '~/_types/scope-state/fold.ts';

// ---------------------------------------------------------------------------
// Extraction helpers — read a single field out of a folded state
// ---------------------------------------------------------------------------

/**
 * Read the client contract out of a fully folded scope state.
 *
 * Shorthand for `TState['contract']`. Used when other types only need the
 * contract and don't care about the rest of the state.
 */
export type ContractFromState<TState extends ScopeStateShape> = TState['contract'];

/**
 * Read the declared error list out of a fully folded scope state.
 *
 * Shorthand for `TState['errors']`.
 */
export type ErrorsFromState<TState extends ScopeStateShape> = TState['errors'];
