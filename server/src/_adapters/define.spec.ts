import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { defineServerAdapter } from './define.ts';

describe('defineServerAdapter', () => {
  it('passes no-arg engine factory and options to setup', () => {
    const setup = vi.fn(() => ({ ok: true }));
    const serve = defineServerAdapter({ id: 'test', hibernation: true, setup });

    const handler = { __wskit: 'server', primitives: [] } as unknown as ServerDefinition;
    const result = serve(handler, { port: 3000 });
    const [createEngine, options] = setup.mock.calls[0]! as unknown as [
      () => Engine,
      { port: number },
    ];

    expect(result).toEqual({ ok: true });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(options).toEqual({ port: 3000 });
    expect(typeof createEngine).toBe('function');

    const engine = createEngine();
    expect(engine).toMatchObject({
      options: { adapterId: 'test', hibernation: true },
    });
  });

  it('resolves hibernation from a function of options', () => {
    let capturedFactory: (() => Engine) | undefined;
    const serve = defineServerAdapter<{ hibernate: boolean }, {}>({
      id: 'cf',
      hibernation: (opts) => opts.hibernate,
      setup(createEngine) {
        capturedFactory = createEngine;
        return {};
      },
    });

    serve({ __wskit: 'server', primitives: [] } as unknown as ServerDefinition, {
      hibernate: false,
    });
    expect(capturedFactory!()).toMatchObject({
      options: { hibernation: false },
    });
  });

  it('factory creates independent engine instances', () => {
    let capturedFactory: (() => Engine) | undefined;
    const serve = defineServerAdapter({
      id: 'multi',
      hibernation: false,
      setup(createEngine) {
        capturedFactory = createEngine;
        return {};
      },
    });

    serve({ __wskit: 'server', primitives: [] } as unknown as ServerDefinition, {} as never);
    const a = capturedFactory!();
    const b = capturedFactory!();
    expect(a).not.toBe(b);
  });
});
