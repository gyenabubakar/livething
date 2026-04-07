import { sequence } from '~/sequence/sequence.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';

function installSequence(): {
  outgoingHandlers: Array<NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>>;
  hook: NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>;
} {
  const outgoingHandlers: Array<NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>> = [];
  const installs = new Set<symbol>();

  const engine = {
    installOnce(key, install) {
      if (installs.has(key)) return;

      installs.add(key);
      install();
    },
    onOutgoing(handler) {
      outgoingHandlers.push(handler);
    },
  } as Pick<EngineAccess, 'installOnce' | 'onOutgoing'> as EngineAccess;

  sequence().__setup?.(engine);

  const hook = outgoingHandlers[0];

  expect(hook).toBeDefined();

  return {
    outgoingHandlers,
    hook: hook!,
  };
}

describe('sequence', () => {
  it('produces correct tag and kind', () => {
    const p = sequence();
    expect(p.__wskit).toBe('sequence');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = sequence();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(sequence.__key);
  });

  it('instances have empty dependencies and requires', () => {
    const p = sequence();
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });

  it('registers its outgoing hook only once', () => {
    const outgoingHandlers: Array<NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>> = [];
    const installs = new Set<symbol>();
    const engine = {
      installOnce(key, install) {
        if (installs.has(key)) return;

        installs.add(key);
        install();
      },
      onOutgoing(handler) {
        outgoingHandlers.push(handler);
      },
    } as Pick<EngineAccess, 'installOnce' | 'onOutgoing'> as EngineAccess;

    sequence().__setup?.(engine);
    sequence().__setup?.(engine);

    expect(outgoingHandlers).toHaveLength(1);
  });

  it('adds an increasing _seq to normal outgoing messages', () => {
    const { hook } = installSequence();
    const first = hook({ event: 'message', payload: { text: 'hello' } });
    const second = hook({ event: 'alert', payload: { level: 'warn' } });

    expect(first).toEqual({
      event: 'message',
      payload: { text: 'hello', _seq: 1 },
    });
    expect(second).toEqual({
      event: 'alert',
      payload: { level: 'warn', _seq: 2 },
    });
  });

  it('skips protocol events that start with an underscore', () => {
    const { hook } = installSequence();
    const protocolMessage = hook({ event: '_ack', payload: {} });
    const appMessage = hook({ event: 'message', payload: { text: 'hello' } });

    expect(protocolMessage).toBeUndefined();
    expect(appMessage).toEqual({
      event: 'message',
      payload: { text: 'hello', _seq: 1 },
    });
  });
});
