import { error } from '~/errors/errors.ts';
import { errors } from '~/errors/primitive.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';

const Forbidden = error('forbidden', v.object({ reason: v.string() }));
const OutOfStock = error('out-of-stock', v.object({ channel: v.string() }));

describe('errors', () => {
  it('produces correct tag', () => {
    const p = errors(Forbidden);
    expect(p.__livething).toBe('errors');
  });

  it('uses singleton identity', () => {
    const p = errors(Forbidden);
    expect(p.__identity).toHaveLength(1);
    expect(typeof p.__identity[0]).toBe('symbol');
  });

  it('stores defs in order', () => {
    const p = errors(Forbidden, OutOfStock);
    expect(p.defs).toHaveLength(2);
    expect(p.defs[0]).toBe(Forbidden);
    expect(p.defs[1]).toBe(OutOfStock);
  });

  it('instances have empty dependencies and requires', () => {
    const p = errors(Forbidden);
    expect(p.__requires).toEqual({});
  });

  it('registers declared error definitions during setup', () => {
    const registered: string[] = [];
    const engine = {
      registerErrorDefinitions(defs) {
        registered.push(...defs.map((def) => def.code));
      },
    } as Pick<EngineAccess, 'registerErrorDefinitions'> as EngineAccess;

    errors(Forbidden, OutOfStock).__setup?.(engine);

    expect(registered).toEqual(['forbidden', 'out-of-stock']);
  });
});
