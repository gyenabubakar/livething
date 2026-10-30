import { LiveThingConfigError } from '@livething/core';
import { server } from '~/_define/server.ts';
import { describe, expect, it } from 'vitest';
import { keepalive } from './capability.ts';

describe('keepalive() capability', () => {
  it('adds the keepalive primitive', () => {
    const base = server({
      capabilities: [keepalive()],
    });
    const definition = base.assemble({ handlers: [] });
    expect(definition.primitives.some((p) => p.__livething === 'keepalive')).toBe(true);
  });

  it('rejects a ping interval that is not less than the idle timeout', () => {
    expect(() => keepalive({ pingIntervalMs: 60_000, idleTimeoutMs: 60_000 })).toThrow(
      /must be less than/,
    );
    expect(() => keepalive({ pingIntervalMs: 60_000, idleTimeoutMs: 60_000 })).toThrow(
      LiveThingConfigError,
    );
  });
});
