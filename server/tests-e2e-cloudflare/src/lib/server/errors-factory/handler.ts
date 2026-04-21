import { event, server } from '@wskit/server';
import { withErrors } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { Forbidden, NotFound } from '../_shared/errors.ts';
import { requireUsername } from '../_shared/upgrade.ts';

const TriggerNotFound = event('trigger-not-found', v.object({}));
const TriggerForbidden = event('trigger-forbidden', v.object({}));

export const errorsFactoryHandler = withErrors(withLifecycle(server<Env>('errors-factory')))
  .errors(NotFound, Forbidden)
  .onUpgrade((request) => requireUsername(request))
  .incoming(TriggerNotFound, () => {
    throw NotFound({ id: 'test-123' });
  })
  .incoming(TriggerForbidden, () => {
    throw Forbidden({ reason: 'Access denied' });
  })
  .build();
