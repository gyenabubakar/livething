import type { BuilderInternals } from '~/_types/feature-methods.ts';

/* oxlint-disable-next-line @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

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
