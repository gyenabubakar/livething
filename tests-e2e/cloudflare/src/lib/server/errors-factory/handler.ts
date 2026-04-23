import { event, server } from '@wskit/server';
import { error, withErrors } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { Forbidden, NotFound } from '../_shared/errors.ts';
import { requireUsername } from '../_shared/upgrade.ts';

const TriggerNotFound = event('trigger-not-found', v.object({}));
const TriggerForbidden = event('trigger-forbidden', v.object({}));
const TriggerSimple = event('trigger-simple', v.object({}));
const TriggerUnregistered = event('trigger-unregistered', v.object({}));

const SimpleError = error('simple-error');
const Unregistered = error('unregistered', v.object({ msg: v.string() }));

export const errorsFactoryHandler = withErrors(withLifecycle(server<Env>('errors-factory')))
  .errors(NotFound, Forbidden, SimpleError)
  .onUpgrade((request) => requireUsername(request))
  .incoming(TriggerNotFound, () => {
    throw NotFound({ id: 'test-123' });
  })
  .incoming(TriggerForbidden, () => {
    throw Forbidden({ reason: 'Access denied' });
  })
  .incoming(TriggerSimple, () => {
    throw SimpleError;
  })
  .incoming(TriggerUnregistered, () => {
    throw Unregistered({ msg: 'this error is not registered' });
  })
  .build();
