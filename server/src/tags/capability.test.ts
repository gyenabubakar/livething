/* oxlint-disable @typescript-eslint/no-unused-vars */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { emits } from '~/emits/emits.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import type { InferClient } from '~/infer-client.ts';
import { tags } from './capability.ts';

const base = server({
  capabilities: [
    tags((ephemeral, persistent) => [
      ephemeral('role', t<string>()),
      ephemeral('color', v.picklist(['red', 'blue', 'green'])),
      persistent('favorite', t<string>()),
    ]),
    emits({ ping: t<{ n: number }>() }),
  ],
});

describe('tags typing', () => {
  it('accepts declared group names on ctx.tags and rejects undeclared ones', () => {
    base.on('act', {
      run(ctx) {
        ctx.tags.ephemeral('role');
        ctx.tags.ephemeral('color');
        ctx.tags.persistent('favorite');
        // @ts-expect-error 'favorite' is persistent, not ephemeral
        ctx.tags.ephemeral('favorite');
        // @ts-expect-error 'role' is ephemeral, not persistent
        ctx.tags.persistent('role');
        // @ts-expect-error undeclared group
        ctx.tags.ephemeral('nope');
      },
    });
  });

  it('gates the upgrade ephemeral-tag sugar to declared ephemeral group names', () => {
    server({
      upgrade() {
        return { userId: 'a', tags: { ephemeral: { role: 'admin' } } };
      },
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });

    // @ts-expect-error 'nope' is not a declared ephemeral group
    server({
      upgrade() {
        return { userId: 'a', tags: { ephemeral: { nope: 'x' } } };
      },
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
  });

  it('rejects ctx.tags group names when no tags() capability is listed', () => {
    const plain = server({});
    plain.on('act', {
      run(ctx) {
        // @ts-expect-error no tag groups declared
        ctx.tags.ephemeral('role');
      },
    });
  });

  it('keeps tags out of the client contract', () => {
    const definition = base.assemble({ handlers: [base.on('act', { run() {} })] });
    type C = InferClient<typeof definition>;
    expectTypeOf<keyof C>().not.toEqualTypeOf<'ephemeralTags' | 'persistentTags'>();
    // @ts-expect-error tags are server-only and never appear on the client contract
    type _Leak = C['ephemeralTags'];
  });
});
