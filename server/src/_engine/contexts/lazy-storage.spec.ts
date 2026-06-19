/* oxlint-disable @typescript-eslint/no-explicit-any */
import { createLazyStorageView } from '~/_engine/contexts/lazy-storage.ts';
import { describe, expect, it, vi } from 'vitest';

function view() {
  const kvImpl = {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  };
  function requireStorage(): any {
    return { sql: {}, kv: kvImpl };
  }
  return { ...createLazyStorageView(requireStorage), kvImpl };
}

describe('lazy kv — reserved-key guard (kv namespace hardening)', () => {
  it('rejects an app key starting with __ or containing ::', async () => {
    const { kv } = view();
    await expect(kv.set('__count', 1)).rejects.toThrow(/reserved form/);
    await expect(kv.set('a::b', 1)).rejects.toThrow(/reserved form/);
    await expect(kv.get('__x')).rejects.toThrow(/reserved form/);
    await expect(kv.delete('x::y')).rejects.toThrow(/reserved form/);
    await expect(kv.list('__')).rejects.toThrow(/reserved form/);
  });

  it('allows a normal app key', async () => {
    const { kv, kvImpl } = view();
    await kv.set('count', 1);
    expect(kvImpl.set).toHaveBeenCalledWith('count', 1, undefined);
    await kv.get('session');
    expect(kvImpl.get).toHaveBeenCalledWith('session');
  });

  it('allows a well-formed plugin-namespaced key — the plugin-scope bypass', async () => {
    const { kv, kvImpl } = view();
    await kv.set('__acme:store::count', 1);
    expect(kvImpl.set).toHaveBeenCalledWith('__acme:store::count', 1, undefined);
    // A sub-`::` inside a plugin key still passes (it's under the plugin prefix).
    await kv.delete('__acme:store::a::b');
    expect(kvImpl.delete).toHaveBeenCalledWith('__acme:store::a::b');
  });
});
