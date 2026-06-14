import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { describe, expect, it } from 'vitest';
import { persistence } from './capability.ts';

describe('persistence() capability', () => {
  it('adds the persistence primitive and the persistence feature flag', () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [persistence()] });
    const handler = base.assemble();
    expect(handler.primitives.some((p) => p.__wskit === 'persistence')).toBe(true);
    expect(handler.__features?.has('persistence')).toBe(true);
  });
});
