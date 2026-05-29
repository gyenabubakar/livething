import {
  deleteDurableMembership,
  hasDurableMembership,
  persistMembership,
} from '~/persistence/membership.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';

function makeCore(exec: ReturnType<typeof vi.fn>): EngineCore {
  return {
    persistenceEnabled: true,
    requireStorage: () => ({ sql: { exec } }),
  } as unknown as EngineCore;
}

function makeExec() {
  return vi.fn(() => ({ toArray: () => [], one: () => null, raw: () => [] }));
}

describe('durable membership identity gate', () => {
  it('skips the durable write for an empty (anonymous) identity', () => {
    const exec = makeExec();
    persistMembership(makeCore(exec), { identity: '', channelName: 'room', channelScope: null });
    expect(exec).not.toHaveBeenCalled();
  });

  it('writes the durable row for a real identity', () => {
    const exec = makeExec();
    persistMembership(makeCore(exec), {
      identity: 'user-1',
      channelName: 'room',
      channelScope: null,
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('skips the durable delete for an empty identity', () => {
    const exec = makeExec();
    deleteDurableMembership(makeCore(exec), {
      identity: '',
      channelName: 'room',
      channelScope: null,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports no durable membership for an empty identity without querying', () => {
    const exec = makeExec();
    const result = hasDurableMembership(makeCore(exec), {
      identity: '',
      channelName: 'room',
      channelScope: null,
    });
    expect(result).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
