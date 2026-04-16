import { applyFeature } from '~/_builder/apply-feature.ts';
import { errors as createErrors } from '~/errors/primitive.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { ErrorDef } from '~/errors/errors.ts';

const KINDS = ['server', 'group'] as const;

/**
 * Add typed error handling support to a server builder.
 *
 * Once enabled, you can call `.errors()` on the builder to register typed
 * error definitions, and `.onError()` / `.onValidationError()` to attach
 * hooks that run when those errors occur.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withErrors(server('app'));
 * ```
 */
export function withErrors<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { errors: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.errors = function (
      this: BuilderInternals,
      ...defs: [ErrorDef<string, unknown>, ...ErrorDef<string, unknown>[]]
    ) {
      this._primitives.push(createErrors(...defs));
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { errors: true }>;
}
