/* oxlint-disable @typescript-eslint/no-explicit-any */
import { createLazyStorageView, PRIVILEGED_KV } from '~/_engine/contexts/lazy-storage.ts';
import { describe, expect, it, vi } from 'vitest';

function view(listResult: string[] = []) {
  const kvImpl = {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => listResult),
  };
  const storage: any = { sql: {}, kv: kvImpl };
  return { ...createLazyStorageView(storage), kvImpl };
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

  it('app cannot forge a well-formed plugin-namespaced key (#11 — no shape exemption)', async () => {
    const { kv, kvImpl } = view();
    await expect(kv.set('__acme:store::secret', 1)).rejects.toThrow(/reserved form/);
    await expect(kv.get('__acme:store::secret')).rejects.toThrow(/reserved form/);
    await expect(kv.delete('__acme:store::secret')).rejects.toThrow(/reserved form/);
    expect(kvImpl.set).not.toHaveBeenCalled();
    expect(kvImpl.get).not.toHaveBeenCalled();
    expect(kvImpl.delete).not.toHaveBeenCalled();
  });

  it('genuine plugin writes go through the privileged kv (#11)', async () => {
    const { kv, kvImpl } = view();
    const privileged = (kv as any)[PRIVILEGED_KV];
    await privileged.set('__acme:store::count', 1);
    expect(kvImpl.set).toHaveBeenCalledWith('__acme:store::count', 1, undefined);
    await privileged.get('__acme:store::count');
    expect(kvImpl.get).toHaveBeenCalledWith('__acme:store::count');
  });
});

describe('lazy kv — list isolation (#12)', () => {
  it('app list() with no prefix filters out every plugin key', async () => {
    const { kv } = view(['count', '__acme:store::secret', 'session', 'a::b']);
    expect(await kv.list()).toEqual(['count', 'session']);
    expect(await kv.list('')).toEqual(['count', 'session']);
  });

  it('app list(prefix) keeps the reserved-form guard', async () => {
    const { kv } = view();
    await expect(kv.list('__acme')).rejects.toThrow(/reserved form/);
  });

  it('the privileged kv list() returns everything unfiltered', async () => {
    const { kv } = view(['__acme:store::count', '__acme:store::seen']);
    const privileged = (kv as any)[PRIVILEGED_KV];
    expect(await privileged.list('__acme:store::')).toEqual([
      '__acme:store::count',
      '__acme:store::seen',
    ]);
  });
});
