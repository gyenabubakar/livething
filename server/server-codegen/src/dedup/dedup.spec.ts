import { dedup } from '~/dedup/dedup.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import { describe, expect, it } from 'vitest';

function installDedup(): {
  outgoingHandlers: Array<NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>>;
  hook: NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>;
} {
  const outgoingHandlers: Array<NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>> = [];
  const installs = new Set<symbol>();
  let nextId = 1;

  const engine = {
    installOnce(key, install) {
      if (installs.has(key)) return;

      installs.add(key);
      install();
    },
    onOutgoing(handler) {
      outgoingHandlers.push(handler);
    },
    generateId(prefix = 'id') {
      return `${prefix}-${nextId++}`;
    },
  } as Pick<EngineAccess, 'generateId' | 'installOnce' | 'onOutgoing'> as EngineAccess;

  dedup().__setup?.(engine);

  const hook = outgoingHandlers[0];

  expect(hook).toBeDefined();

  return {
    outgoingHandlers,
    hook: hook!,
  };
}

describe('dedup', () => {
  it('produces correct tag and kind', () => {
    const p = dedup();
    expect(p.__wskit).toBe('dedup');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = dedup();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(dedup.__key);
  });

  it('instances have empty dependencies and requires', () => {
    const p = dedup();
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });

  it('registers its outgoing hook only once', () => {
    const outgoingHandlers: Array<NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>> = [];
    const installs = new Set<symbol>();
    let nextId = 1;
    const engine = {
      installOnce(key, install) {
        if (installs.has(key)) return;

        installs.add(key);
        install();
      },
      onOutgoing(handler) {
        outgoingHandlers.push(handler);
      },
      generateId(prefix = 'id') {
        return `${prefix}-${nextId++}`;
      },
    } as Pick<EngineAccess, 'generateId' | 'installOnce' | 'onOutgoing'> as EngineAccess;

    dedup().__setup?.(engine);
    dedup().__setup?.(engine);

    expect(outgoingHandlers).toHaveLength(1);
  });

  it('adds a unique _messageId to normal outgoing messages', () => {
    const { hook } = installDedup();
    const first = hook({ event: 'message', payload: { text: 'hello' } });
    const second = hook({ event: 'alert', payload: { level: 'warn' } });

    expect(first).toEqual({
      event: 'message',
      payload: { text: 'hello', _messageId: 'msg-1' },
    });
    expect(second).toEqual({
      event: 'alert',
      payload: { level: 'warn', _messageId: 'msg-2' },
    });
  });

  it('skips protocol events that start with an underscore', () => {
    const { hook } = installDedup();
    const protocolMessage = hook({ event: '_ack', payload: {} });
    const appMessage = hook({ event: 'message', payload: { text: 'hello' } });

    expect(protocolMessage).toBeUndefined();
    expect(appMessage).toEqual({
      event: 'message',
      payload: { text: 'hello', _messageId: 'msg-1' },
    });
  });

  it('still dedups module-owned outgoing events with a double underscore prefix', () => {
    const { hook } = installDedup();
    const moduleMessage = hook({
      event: '__acme:analytics:flushed',
      payload: { count: 1 },
    });

    expect(moduleMessage).toEqual({
      event: '__acme:analytics:flushed',
      payload: { count: 1, _messageId: 'msg-1' },
    });
  });
});
