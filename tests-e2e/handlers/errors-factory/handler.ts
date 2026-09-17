import { errors, server } from '@wskit/server';
import { error, WSKitError } from '@wskit/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { Forbidden, NotFound } from '../_shared/errors.ts';
import { requireUsername } from '../_shared/upgrade.ts';

const SimpleError = error('simple-error');
const Unregistered = error('unregistered', v.object({ msg: v.string() }));
// A WSKitError whose detail carries a value JSON.stringify cannot
// serialize. Used by the e2e that pins the dispatcher fallback path:
// the client must still receive an __error__ frame instead of having the
// connection silently lose the response.
const BigIntDetail = error('bigint-detail');

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [errors([NotFound, Forbidden, SimpleError, BigIntDetail])],
});

const handleTriggerNotFound = base.on('trigger-not-found', {
  input: v.object({}),
  run() {
    throw NotFound({ id: 'test-123' });
  },
});

const handleTriggerForbidden = base.on('trigger-forbidden', {
  input: v.object({}),
  run() {
    throw Forbidden({ reason: 'Access denied' });
  },
});

const handleTriggerSimple = base.on('trigger-simple', {
  input: v.object({}),
  run() {
    // Code-only error: error('simple-error') returns a factory; call it to get
    // the WSKitError. (Throwing the bare factory would normalize to
    // internal-error since a function is not a WSKitError.)
    throw SimpleError();
  },
});

const handleTriggerUnregistered = base.on('trigger-unregistered', {
  input: v.object({}),
  run() {
    throw Unregistered({ msg: 'this error is not registered' });
  },
});

const handleTriggerBigint = base.on('trigger-bigint', {
  input: v.object({}),
  run() {
    // Build a WSKitError whose detail is non-serializable. The engine
    // must not let JSON.stringify crash the dispatcher.
    throw new WSKitError('bigint-detail', { amount: 1n });
  },
});

export const errorsFactoryDefinition = base.assemble({
  handlers: [
    handleTriggerNotFound,
    handleTriggerForbidden,
    handleTriggerSimple,
    handleTriggerUnregistered,
    handleTriggerBigint,
  ],
});

export type ErrorsFactoryClient = InferClient<typeof errorsFactoryDefinition>;
