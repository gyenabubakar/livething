import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { describe, expect, it } from 'vitest';
import { ack } from './capability.ts';

describe('ack() capability', () => {
  it('adds the ack primitive and the ack feature flag', () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [ack()] });
    const handler = base.assemble();
    expect(handler.primitives.some((p) => p.__wskit === 'ack')).toBe(true);
    expect(handler.__features?.has('ack')).toBe(true);
  });
});
