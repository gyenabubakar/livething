import { applyFeature } from '~/_types/feature-methods.ts';
import { NamespaceBuilder } from '~/namespace/builder.ts';
import { namespace as createNamespace } from '~/namespace/namespace.ts';
import type { ServerBuilder } from '~/_builder/server-builder.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';

const KINDS = ['server', 'group'] as const;

export function withNamespaces<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { namespaces: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.namespace = function (
      this: BuilderInternals,
      name: string,
      callback: (...args: unknown[]) => unknown,
    ) {
      const nsBuilder = new NamespaceBuilder(
        this as unknown as ServerBuilder<ScopeStateShape>,
        [],
        name,
      );
      for (const applicator of this._featureApplicators) {
        applicator(nsBuilder, 'namespace');
      }
      callback(nsBuilder);
      return (createNamespace as (...args: unknown[]) => unknown)(name, ...nsBuilder._primitives);
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { namespaces: true }>;
}
