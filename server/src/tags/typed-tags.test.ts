import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { describe, expectTypeOf, it } from 'vitest';
import type { SlotsOf } from '~/_define/capability.ts';
import { tags } from './capability.ts';

const cap = tags((ephemeral, persistent) => [
  ephemeral('user', t<string>()),
  ephemeral('role', t<'admin' | 'moderator' | 'viewer'>()),
  persistent('favourite', t<string>()),
]);

type Slots = SlotsOf<typeof cap>;

describe('typed tags — capability slot derivation', () => {
  it('derives the ephemeral group→value map from the tags builder', () => {
    expectTypeOf<Slots['ephemeralTags']['user']>().toEqualTypeOf<string>();
    expectTypeOf<Slots['ephemeralTags']['role']>().toEqualTypeOf<
      'admin' | 'moderator' | 'viewer'
    >();
  });

  it('derives the persistent group→value map from the tags builder', () => {
    expectTypeOf<Slots['persistentTags']['favourite']>().toEqualTypeOf<string>();
  });
});

describe('typed tags — ctx.tags keys', () => {
  it("types a group handle's keys by the group's declared type", () => {
    const base = server({ capabilities: [cap] });
    base.on('promote-member', {
      run(ctx) {
        const role = ctx.tags.ephemeral('role');
        role.add('moderator');
        expectTypeOf(role.has).parameter(0).toEqualTypeOf<'admin' | 'moderator' | 'viewer'>();
        // @ts-expect-error 'owner' is not a role
        role.add('owner');
        // @ts-expect-error 'owner' is not a role
        role.remove('owner');
        // @ts-expect-error 'owner' is not a role
        role.ref('owner');

        ctx.tags.ephemeral('user').add('u_amara');
        ctx.tags.persistent('favourite').add('room:general');
      },
    });
  });
});
