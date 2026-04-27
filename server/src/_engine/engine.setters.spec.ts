/* oxlint-disable @typescript-eslint/no-explicit-any */
import { server } from '~/_builder/server-builder.ts';
import { Engine } from '~/_engine/engine.ts';
import { describe, expect, it, vi } from 'vitest';

function makeEngine() {
  const def = server('test').build();
  return new Engine(def as any, { adapterId: 'test' });
}

describe('Engine.setLogger', () => {
  it('routes engine log calls through the adapter-supplied Logger', () => {
    const engine = makeEngine();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();

    engine.setLogger({ info, warn, error });

    const logger = engine.getLogger();
    logger.info('hello', { a: 1 });
    logger.warn('careful', { b: 2 });
    logger.error('boom', { c: 3 });

    expect(info).toHaveBeenCalledWith('hello', { a: 1 });
    expect(warn).toHaveBeenCalledWith('careful', { b: 2 });
    expect(error).toHaveBeenCalledWith('boom', { c: 3 });
  });

  it('falls back to a console-backed Logger when setLogger is never called', () => {
    const engine = makeEngine();
    const logger = engine.getLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('replaces the active Logger when setLogger is called more than once', () => {
    const engine = makeEngine();
    const first = vi.fn();
    const second = vi.fn();

    engine.setLogger({ info: first, warn: () => {}, error: () => {} });
    engine.setLogger({ info: second, warn: () => {}, error: () => {} });

    engine.getLogger().info('after-replace');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('after-replace');
  });
});

describe('Engine.getCompiled', () => {
  it('returns the compiled handler definition built at construction', () => {
    const engine = makeEngine();
    const compiled = engine.getCompiled();
    expect(compiled).toBeDefined();
    expect(compiled.incoming).toBeInstanceOf(Map);
    expect(compiled.outgoing).toBeInstanceOf(Map);
  });
});
