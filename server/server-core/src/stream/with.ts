import { applyFeature } from '~/_builder/apply-feature.ts';
import { StreamBuilder } from '~/stream/builder.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { EventContract } from '~/event.ts';
import type { Validator } from '~/types.ts';

function streamImpl(
  parent: BuilderInternals,
  eventContract: EventContract,
  chunkSchema: Validator,
  callbackOrOptions?: { broadcast?: boolean } | ((...args: unknown[]) => unknown),
  maybeCallback?: (...args: unknown[]) => unknown,
) {
  const isCallback3 = typeof callbackOrOptions === 'function';
  const options = isCallback3
    ? undefined
    : typeof callbackOrOptions === 'object'
      ? callbackOrOptions
      : undefined;
  const callback = isCallback3 ? callbackOrOptions : maybeCallback;
  const builder = new StreamBuilder(
    parent,
    parent._primitives,
    eventContract,
    chunkSchema,
    options,
  );
  if (callback) {
    callback(builder);
    return parent;
  }
  return builder;
}

const KINDS = ['server', 'group', 'namespace'] as const;

export function withStreams<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { streams: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.stream = function (
      this: BuilderInternals,
      eventContract: EventContract,
      chunkSchema: Validator,
      callbackOrOptions?: { broadcast?: boolean } | ((...args: unknown[]) => unknown),
      maybeCallback?: (...args: unknown[]) => unknown,
    ) {
      return streamImpl(this, eventContract, chunkSchema, callbackOrOptions, maybeCallback);
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { streams: true }>;
}
