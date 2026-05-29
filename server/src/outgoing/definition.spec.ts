import { t } from '~/_api/definitions.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { outgoing } from './definition.ts';

describe('outgoing definition', () => {
  it('stores no validator when given a t<>() marker (type-only)', () => {
    const def = outgoing('message', t<{ text: string }>());
    expect(def._).toBe('outgoing');
    expect(def.name).toBe('message');
    expect(def.schema).toBeUndefined();
  });

  it('stores the validator when given a Standard Schema', () => {
    const schema = v.object({ text: v.string() });
    const def = outgoing('message', schema);
    expect(def.schema).toBe(schema);
  });

  it('stores no validator when given no payload at all', () => {
    const def = outgoing('tick');
    expect(def.schema).toBeUndefined();
  });

  it('rejects an event name that starts with the reserved __ prefix', () => {
    expect(() => outgoing('__nope')).toThrow(/reserved '__' prefix/);
  });
});
