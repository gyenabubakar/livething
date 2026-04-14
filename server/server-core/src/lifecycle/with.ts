import { applyFeature } from '~/_types/feature-methods.ts';
import {
  onBinary as createOnBinary,
  onConnect as createOnConnect,
  onDisconnect as createOnDisconnect,
  onError as createOnError,
  onInit as createOnInit,
  onShutdown as createOnShutdown,
  onUpgrade as createOnUpgrade,
  onValidationError as createOnValidationError,
} from '~/lifecycle/lifecycle.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';

function addLifecycleMethod(
  t: Record<string, unknown>,
  name: string,
  factory: (...args: never[]) => unknown,
) {
  t[name] = function (this: BuilderInternals, handler: (...args: never[]) => unknown) {
    this._primitives.push((factory as (handler: unknown) => unknown)(handler) as Primitive);
    return this;
  };
}

const KINDS = ['server', 'group'] as const;

export function withLifecycle<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { lifecycle: true }> {
  applyFeature(builder, KINDS, (t) => {
    addLifecycleMethod(t, 'onInit', createOnInit);
    addLifecycleMethod(t, 'onConnect', createOnConnect);
    addLifecycleMethod(t, 'onDisconnect', createOnDisconnect);
    addLifecycleMethod(t, 'onShutdown', createOnShutdown);
    addLifecycleMethod(t, 'onError', createOnError);
    addLifecycleMethod(t, 'onUpgrade', createOnUpgrade);
    addLifecycleMethod(t, 'onBinary', createOnBinary);
    addLifecycleMethod(t, 'onValidationError', createOnValidationError);
  });
  return builder as ServerBuilderFull<TState, TFeatures & { lifecycle: true }>;
}
