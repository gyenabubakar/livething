import { hibernation } from '~/hibernation/hibernation.ts';
import { describe, expect, it } from 'vitest';

describe('hibernation()', () => {
  it('defaults to enabled', () => {
    const primitive = hibernation();
    expect(primitive.enabled).toBe(true);
    expect(primitive.__requires.hibernation).toBe(true);
  });

  it('accepts false explicitly', () => {
    const primitive = hibernation(false);
    expect(primitive.enabled).toBe(false);
  });

  it('does not declare the hibernation requirement when disabled', () => {
    const primitive = hibernation(false);
    expect(primitive.__requires.hibernation).toBeUndefined();
  });

  it('registers the hibernation setting during setup', () => {
    const primitive = hibernation(false);
    let enabled = true;

    primitive.__setup?.({
      setHibernationEnabled(value: boolean) {
        enabled = value;
      },
    } as never);

    expect(enabled).toBe(false);
  });
});
