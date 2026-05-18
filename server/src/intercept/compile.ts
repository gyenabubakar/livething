/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { AnyPostIntercept } from '~/_engine/compile/types.ts';

// Append a post-intercept to the per-event list for a given scope.
export function addPostIntercept(
  event: string,
  primitive: AnyPostIntercept,
  map: Map<string, AnyPostIntercept[]>,
): void {
  const existing = map.get(event) ?? [];
  existing.push(primitive);
  map.set(event, existing);
}
