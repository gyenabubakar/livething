import { event, server } from '@wskit/server';
import { error, withErrors } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const NotFound = error('not-found', v.object({ id: v.string() }));

const Lookup = event('lookup', v.object({ id: v.string() }));

export const errorsFactoryHandler = withErrors(withLifecycle(server<Env>('errors-factory')))
  .errors(NotFound)
  .onUpgrade((request) => requireUsername(request))
  .incoming(Lookup, (_ctx, payload) => {
    if (payload.id === 'missing') throw NotFound({ id: payload.id });
  })
  .build();
