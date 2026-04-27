import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { defineServerAdapter } from './define.ts';

const noopHibernation = {
  persist: vi.fn(),
  restore: vi.fn(() => undefined),
};

describe('defineServerAdapter', () => {
  it('passes no-arg engine factory and options to setup', () => {
    const setup = vi.fn(() => ({ ok: true }));
    const serve = defineServerAdapter({ id: 'test', hibernation: noopHibernation, setup });

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
      options: { adapterId: 'test', hibernation: noopHibernation },
    });
  });

  it('passes the adapter hibernation API straight through to engine options', () => {
    let capturedFactory: (() => Engine) | undefined;
    const api = { persist: vi.fn(), restore: vi.fn(() => ({ id: 'restored' })) };
    const serve = defineServerAdapter({
      id: 'cf',
      hibernation: api,
      setup(createEngine) {
        capturedFactory = createEngine;
        return {};
      },
    });

    serve({ __wskit: 'server', primitives: [] } as unknown as ServerDefinition, {} as never);
    expect(capturedFactory!()).toMatchObject({ options: { hibernation: api } });
  });

  it('omits hibernation in engine options when the adapter does not provide one', () => {
    let capturedFactory: (() => Engine) | undefined;
    const serve = defineServerAdapter({
      id: 'no-hib',
      setup(createEngine) {
        capturedFactory = createEngine;
        return {};
      },
    });

    serve({ __wskit: 'server', primitives: [] } as unknown as ServerDefinition, {} as never);
    const engine = capturedFactory!();
    expect((engine as unknown as { options: { hibernation?: unknown } }).options.hibernation).toBe(
      undefined,
    );
  });

  it('factory creates independent engine instances', () => {
    let capturedFactory: (() => Engine) | undefined;
    const serve = defineServerAdapter({
      id: 'multi',
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
