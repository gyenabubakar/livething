import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { describe, expect, it } from 'vitest';
import { keepalive } from './capability.ts';

describe('keepalive() capability', () => {
  it('adds the keepalive primitive and the keepalive feature flag', () => {
    const base = define({
      env: t<Record<string, never>>(),
      capabilities: [keepalive({ pingIntervalMs: 30_000, idleTimeoutMs: 60_000 })],
    });
    const handler = base.assemble({ handlers: [] });
    expect(handler.primitives.some((p) => p.__wskit === 'keepalive')).toBe(true);
    expect(handler.__features?.has('keepalive')).toBe(true);
  });

  it('rejects a ping interval that is not less than the idle timeout', () => {
    expect(() => keepalive({ pingIntervalMs: 60_000, idleTimeoutMs: 60_000 })).toThrow(
      /must be less than/,
    );
  });
});
