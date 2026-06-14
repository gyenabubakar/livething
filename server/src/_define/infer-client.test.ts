import { t } from '~/_api/definitions.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { error } from '~/errors/errors.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import type { InferClient } from '~/infer-client.ts';
import { define } from './define.ts';

const NotFound = error('not-found', v.object({ id: v.string() }));
const Forbidden = error('forbidden', v.object({ reason: v.string() }));

const base = define({
  env: t<{ SECRET: string }>(),
  upgrade: () => ({ identity: 'x', meta: { username: 'x' } }),
  capabilities: [
    emits({ welcome: t<{ username: string }>() }),
    emits({ goodbye: t<{ username: string }>() }),
    errors([NotFound, Forbidden]),
  ],
});

const handleEcho = base.on('echo', {
  input: v.object({ text: v.string() }),
  run() {},
});

const handleAnything = base.on('anything', {
  run() {},
});

const handler = base.assemble(handleEcho, handleAnything);
type C = InferClient<typeof handler>;

describe('InferClient for define()', () => {
  it('maps each emits capability to a client incoming event', () => {
    expectTypeOf<C['incoming']['welcome']>().toEqualTypeOf<{ username: string }>();
    expectTypeOf<C['incoming']['goodbye']>().toEqualTypeOf<{ username: string }>();
  });

  it('maps each base.on handler to a client outgoing event', () => {
    expectTypeOf<C['outgoing']['echo']>().toEqualTypeOf<{ text: string }>();
  });

  it('types a schemaless handler payload as unknown', () => {
    expectTypeOf<C['outgoing']['anything']>().toEqualTypeOf<unknown>();
  });

  it('maps every declared error to its detail type', () => {
    expectTypeOf<C['errors']['not-found']>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<C['errors']['forbidden']>().toEqualTypeOf<{ reason: string }>();
  });

  it('rejects a builder method whose capability was not listed', () => {
    // `requests()` is not in capabilities, so `base.request` does not exist.
    // @ts-expect-error base.request requires the requests() capability
    base.request;
  });

  it('rejects a send to an undeclared event', () => {
    base.on('typed-send', {
      run(ctx) {
        // @ts-expect-error 'not-emitted' is not declared by any emits() capability
        ctx.send('not-emitted', {});
      },
    });
  });
});
