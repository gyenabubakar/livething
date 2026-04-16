import { applyFeature } from '~/_builder/apply-feature.ts';
import { ChannelBuilder } from '~/channel/builder.ts';
import { channel as createChannel } from '~/channel/channel.ts';
import type { ServerBuilder } from '~/_builder/server-builder.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { ChannelPattern } from '~/channel/channel.ts';

const KINDS = ['server', 'group'] as const;

/**
 * Add pub/sub channel support to a server builder.
 *
 * Once enabled, you can call `.channel()` on the builder to define named
 * pub/sub channels that connections can subscribe to and leave dynamically at
 * runtime.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withChannels(server('app'));
 * ```
 */
export function withChannels<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { channels: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.channel = function (
      this: BuilderInternals,
      pattern: ChannelPattern,
      callback: (...args: unknown[]) => unknown,
    ) {
      const chBuilder = new ChannelBuilder(
        this as unknown as ServerBuilder<ScopeStateShape>,
        [],
        pattern,
      );
      for (const apply of this._featureApplicators) {
        apply(chBuilder, 'channel');
      }
      callback(chBuilder);
      return (createChannel as (...args: unknown[]) => unknown)(pattern, ...chBuilder._primitives);
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { channels: true }>;
}
