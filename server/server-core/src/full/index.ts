import { withChannels } from '~/channel/with.ts';
import { withErrors } from '~/errors/with.ts';
import { server as createServer } from '~/index.ts';
import { withInfrastructure } from '~/infrastructure/index.ts';
import { withIntercept } from '~/intercept/with.ts';
import { withLifecycle } from '~/lifecycle/with.ts';
import { withNamespaces } from '~/namespace/with.ts';
import { withReplayCustom } from '~/replay/custom/with.ts';
import { withReplay } from '~/replay/with.ts';
import { withRequests } from '~/request/with.ts';
import { withScheduled } from '~/scheduled/with.ts';
import { withStreams } from '~/stream/with.ts';

export function server<TEnv extends object = Record<string, unknown>>(name: string) {
  return withStreams(
    withRequests(
      withNamespaces(
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
  );
}
