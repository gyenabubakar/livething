import { error } from '~/errors/errors.ts';
import { errors } from '~/errors/index.ts';
import { defineModule } from '~/modules/define.ts';
import { outgoing } from '~/outgoing/index.ts';
import { t } from '~/t.ts';
import { describe, expect, it } from 'vitest';

describe('defineModule()', () => {
  it('creates module instances with outgoing declarations and errors', () => {
    const RateLimited = error('rate-limited', (value: unknown) => value as { retryAfter: number });

    const Analytics = defineModule({
      id: 'acme:analytics',
      key: Symbol('acme:analytics'),
      outgoing: [outgoing('flushed', t<{ count: number }>())] as const,
      errors: errors(RateLimited),
      setup() {
        return () => ({
          flush() {
            return { count: 1 };
          },
        });
      },
    });

    const instance = Analytics({});

    expect(instance.id).toBe('acme:analytics');
    expect(instance.outgoing[0]?.event).toBe('flushed');
    expect(instance.errors?.defs[0]?.code).toBe('rate-limited');
  });

  it('rejects invalid module ids', () => {
    expect(() => {
      return defineModule({
        id: 'BadName',
        key: Symbol('bad'),
        setup() {
          return () => ({});
        },
      });
    }).toThrow(/author:name/);
  });
});
