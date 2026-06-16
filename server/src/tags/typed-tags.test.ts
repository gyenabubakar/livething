import { t } from '~/_api/definitions.ts';
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
