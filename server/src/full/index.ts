/**
 * `@wskit/server/full` — batteries-included server entry point.
 *
 * Re-exports the contract + implement API plus a legacy `server()` builder
 * with every `with*` wrapper pre-applied (kept for backwards compatibility
 * with code that hasn't migrated yet).
 */

import { server as createServer } from '~/_builder/index.ts';
import { withChannels } from '~/channel/with.ts';
import { withErrors } from '~/errors/with.ts';
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

// Primary new API surface — re-export from root.
export {
  channel,
  contract,
  error,
  group,
  implement,
  incoming,
  namespace,
  nudge,
  outgoing,
  request,
  scheduled,
  scope,
  stream,
  t,
  use,
} from '~/index.ts';
export type {
  ChannelContract,
  ChannelCtx,
  Contract,
  ContractConfig,
  Ctx,
  Definition,
  GroupHandle,
  NamespaceContract,
  NamespaceCtx,
  TagRefHandle,
  TagsApi,
} from '~/index.ts';
export { event } from '~/event.ts';

/**
 * Legacy `server()` builder with every `with*` wrapper pre-applied. Kept for
 * code that still uses the chain-of-`with` API. New code should use
 * `contract()` + `implement()` from `@wskit/server`.
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
