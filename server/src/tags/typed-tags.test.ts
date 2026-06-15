import { contract } from '~/_api/contract.ts';
import { t } from '~/_api/definitions.ts';
import { describe, expectTypeOf, it } from 'vitest';

const c = contract('tags-typing', {
  env: t<Record<string, unknown>>(),
  tags: (ephemeral, persistent) => [
    ephemeral('user', t<string>()),
    ephemeral('role', t<'admin' | 'moderator' | 'viewer'>()),
    persistent('favourite', t<string>()),
  ],
  definitions: [],
});

describe('typed tags — contract value-map derivation', () => {
  it('derives the ephemeral group→value map from the tags builder', () => {
    expectTypeOf<(typeof c)['tagGroups']['ephemeral']>().toEqualTypeOf<{
      user: string;
      role: 'admin' | 'moderator' | 'viewer';
    }>();
  });

  it('derives the persistent group→value map from the tags builder', () => {
    expectTypeOf<(typeof c)['tagGroups']['persistent']>().toEqualTypeOf<{
      favourite: string;
    }>();
  });
});
