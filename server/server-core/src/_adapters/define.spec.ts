import { describe, expect, it, vi } from 'vitest';
import { defineServerAdapter } from './define.ts';

describe('defineServerAdapter', () => {
  it('creates a serve function that passes handler, options, and an Engine to setup', async () => {
    const setup = vi.fn(() => ({ ok: true }));
    const serve = defineServerAdapter({
      id: 'test',
      hibernation: true,
      setup,
    });

    const handler = { __wskit: 'server', primitives: [] } as any;
    const result = await serve(handler, { port: 3000 });
    const [receivedHandler, engine, options] = setup.mock.calls[0]! as unknown as [any, any, any];

    expect(result).toEqual({ ok: true });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(receivedHandler).toBe(handler);
    expect(options).toEqual({ port: 3000 });
    expect(engine).toMatchObject({
      options: { adapterId: 'test', hibernation: true },
    });
  });
});
