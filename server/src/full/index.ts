import { withChannels } from '~/channel/with.ts';
import { withErrors } from '~/errors/with.ts';
import { server as createServer } from '~/index.ts';
import { withInfrastructure } from '~/infrastructure/index.ts';
import { withIntercept } from '~/intercept/with.ts';
import { withLifecycle } from '~/lifecycle/with.ts';
import { withNamespaces } from '~/namespace/with.ts';
import { withPersistence } from '~/persistence/with.ts';
import { withReplayCustom } from '~/replay/custom/with.ts';
import { withReplay } from '~/replay/with.ts';
import { withRequests } from '~/request/with.ts';
import { withScheduled } from '~/scheduled/with.ts';
import { withStreams } from '~/stream/with.ts';
import { withTags } from '~/tags/with.ts';

/**
 * Create a batteries-included server builder with every feature pre-registered.
 *
 * Use this when you want the quickest path to a working server and don't mind
 * paying the full bundle cost up front. Every feature (lifecycle, channels,
 * namespaces, intercepts, streams, requests, replay, scheduled tasks, errors,
 * and infrastructure) is enabled out of the box, so the builder exposes every
 * method without you wiring any `with*` wrapper yourself.
 *
 * ### How this differs from `server` in `@wskit/server`
 *
 * Both entry points create a builder — the difference is which methods are
 * available to chain:
 *
 * - **`@wskit/server`** — minimal starting point. The returned builder has
 *   `.incoming`, `.outgoing`, `.use`, `.group`, `.build`. You opt into each
 *   feature by wrapping the builder with the matching `with*` function
 *   (`withChannels`, `withStreams`, `withReplay`, etc.) or by importing the
 *   feature primitive and registering it with `.use(...)`. Smaller bundles
 *   when you only need a subset.
 * - **`@wskit/server/full`** (this module) — every `with*` wrapper is applied
 *   for you, so the builder already has `.channel`, `.namespace`, `.stream`,
 *   `.request`, `.replay`, `.scheduled`, `.intercept`, lifecycle hooks, and
 *   infrastructure (`.ack`, `.dedup`, `.heartbeat`, `.sequence`, `.hibernation`)
 *   chainable directly. Larger bundles; fewer decisions.
 *
 * Pick `@wskit/server` when you care about tree-shaking. Pick
 * `@wskit/server/full` when you want one import and every feature on tap.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server/full';
 *
 * const handler = server('my-app')
 *   .onConnect((ctx) => { ... })
 *   .outgoing(Greeting)
 *   .incoming(SendChat, (ctx, payload) => { ... })
 *   .build();
 * ```
 */
export function server<TEnv extends object = Record<string, unknown>>(name: string) {
  return withTags(
    withStreams(
      withRequests(
        withNamespaces(
          withPersistence(
            withChannels(
              withReplayCustom(
                withReplay(
                  withScheduled(
                    withIntercept(
                      withErrors(withLifecycle(withInfrastructure(createServer<TEnv>(name)))),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
