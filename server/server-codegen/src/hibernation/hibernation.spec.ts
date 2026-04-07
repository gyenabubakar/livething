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
});
