import type { BuilderInternals } from '~/_types/feature-methods.ts';

/* oxlint-disable-next-line @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

/**
 * Attach one feature's methods to a builder and register an applicator so
 * the same methods are added to child builders (groups, channels, namespaces)
 * that match the allowed `kinds`.
 */
export function applyFeature(
  builder: BuilderInternals,
  kinds: readonly string[],
  install: (target: Obj) => void,
): void {
  install(builder as Obj);
  builder._featureApplicators.push((target, kind) => {
    if (kinds.includes(kind)) install(target as Obj);
  });
}
