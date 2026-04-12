import { describe, expect, it, vi } from 'vitest';
import { defineServerAdapter } from './define.ts';

describe('defineServerAdapter', () => {
  it('passes engine factory and options to setup', async () => {
    const setup = vi.fn(() => ({ ok: true }));
    const serve = defineServerAdapter({
      id: 'test',
      hibernation: true,
      setup,
    });

    const handler = { __wskit: 'server', primitives: [] } as any;
    const result = await serve(handler, { port: 3000 });
    const [createEngine, options] = setup.mock.calls[0]! as unknown as [() => any, any];

    expect(result).toEqual({ ok: true });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(options).toEqual({ port: 3000 });
    expect(typeof createEngine).toBe('function');

    const engine = createEngine();
    expect(engine).toMatchObject({
      options: { adapterId: 'test', hibernation: true },
    });
  });

  it('factory creates independent engine instances', () => {
    let capturedFactory: (() => any) | undefined;
    const serve = defineServerAdapter({
      id: 'multi',
      hibernation: false,
      setup(createEngine) {
        capturedFactory = createEngine;
        return {};
      },
    });

    serve({ __wskit: 'server', primitives: [] } as any, undefined as any);
    const a = capturedFactory!();
    const b = capturedFactory!();
    expect(a).not.toBe(b);
  });
});
