import { applyFeature } from '~/_builder/apply-feature.ts';
import { request as createRequest } from '~/request/request.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { EventContract } from '~/event.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

const KINDS = ['server', 'group', 'namespace', 'channel'] as const;

/**
 * Add request-response support to a server builder.
 *
 * Once enabled, you can call `.request()` on the builder to define typed
 * request-response patterns where the client sends a request and the server
 * replies with a typed payload.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withRequests(server('app'));
 * ```
 */
export function withRequests<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { requests: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.request = function (
      this: BuilderInternals,
      eventContract: EventContract,
      _responseSchema: Validator,
      handler: (...args: never[]) => unknown,
    ) {
      this._primitives.push(
        (createRequest as (...args: unknown[]) => unknown)(eventContract.event, handler, {
          validator: eventContract.schema,
        }) as Primitive,
      );
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { requests: true }>;
}
