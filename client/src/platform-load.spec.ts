import { afterEach, describe, expect, it, vi } from 'vitest';

// React Native 0.87 and older (and JSC) have no TextDecoder, and may lack TextEncoder too.
// An app that never uses sse() or binary() must still be able to import the client.
describe('loading the client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('works on a platform with no TextEncoder or TextDecoder', async () => {
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('TextDecoder', undefined);
    vi.resetModules();

    const loaded = await import('./index.ts');

    expect(typeof loaded.connect).toBe('function');
    expect(typeof loaded.sse).toBe('function');
  });
});
