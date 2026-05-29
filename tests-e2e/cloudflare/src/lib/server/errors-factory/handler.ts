import { contract, error, implement, incoming, t } from '@wskit/server';
import { WskitError } from '@wskit/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { Forbidden, NotFound } from '../_shared/errors.ts';
import { requireUsername } from '../_shared/upgrade.ts';

const SimpleError = error('simple-error');
const Unregistered = error('unregistered', v.object({ msg: v.string() }));
// A WskitError whose detail carries a value JSON.stringify cannot
// serialize. Used by the e2e that pins the dispatcher fallback path:
// the client must still receive an __error__ frame instead of having the
// connection silently lose the response.
const BigIntDetail = error('bigint-detail');

export const errorsFactoryContract = contract('errors-factory', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  errors: [NotFound, Forbidden, SimpleError, BigIntDetail],
  definitions: [
    incoming('trigger-not-found', v.object({})),
    incoming('trigger-forbidden', v.object({})),
    incoming('trigger-simple', v.object({})),
    incoming('trigger-unregistered', v.object({})),
    incoming('trigger-bigint', v.object({})),
  ],
});

export const errorsFactoryHandler = implement(errorsFactoryContract)
  .onUpgrade((request) => requireUsername(request))
  .on('trigger-not-found', () => {
    throw NotFound({ id: 'test-123' });
  })
  .on('trigger-forbidden', () => {
    throw Forbidden({ reason: 'Access denied' });
  })
  .on('trigger-simple', () => {
    throw SimpleError;
  })
  .on('trigger-unregistered', () => {
    throw Unregistered({ msg: 'this error is not registered' });
  })
  .on('trigger-bigint', () => {
    // Build a WskitError whose detail is non-serializable. The engine
    // must not let JSON.stringify crash the dispatcher.
    throw new WskitError('bigint-detail', { amount: 1n });
  })
  .build();

export type ErrorsFactoryClient = InferClient<typeof errorsFactoryHandler>;
