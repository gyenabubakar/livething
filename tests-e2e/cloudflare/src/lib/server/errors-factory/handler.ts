import { event, server } from '@wskit/server';
import { error, withErrors, WskitError } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { Forbidden, NotFound } from '../_shared/errors.ts';
import { requireUsername } from '../_shared/upgrade.ts';

const TriggerNotFound = event('trigger-not-found', v.object({}));
const TriggerForbidden = event('trigger-forbidden', v.object({}));
const TriggerSimple = event('trigger-simple', v.object({}));
const TriggerUnregistered = event('trigger-unregistered', v.object({}));
const TriggerBigInt = event('trigger-bigint', v.object({}));

const SimpleError = error('simple-error');
const Unregistered = error('unregistered', v.object({ msg: v.string() }));
// A WskitError whose detail carries a value JSON.stringify cannot
// serialize. Used by the e2e that pins the dispatcher fallback path:
// the client must still receive an _error frame instead of having the
// connection silently lose the response.
const BigIntDetail = error('bigint-detail');

export const errorsFactoryHandler = withErrors(withLifecycle(server<Env>('errors-factory')))
  .errors(NotFound, Forbidden, SimpleError, BigIntDetail)
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
  .incoming(TriggerBigInt, () => {
    // Build a WskitError whose detail is non-serializable. The engine
    // must not let JSON.stringify crash the dispatcher.
    throw new WskitError('bigint-detail', { amount: 1n });
  })
  .build();
