import { describe, expectTypeOf, it } from 'vitest';
import type { CtxKvClient } from './handler.ts';

describe('CtxKvClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<CtxKvClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxKvClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxKvClient['requests']>().not.toBeAny();
    expectTypeOf<CtxKvClient['streams']>().not.toBeAny();
    expectTypeOf<CtxKvClient['channels']>().not.toBeAny();
    expectTypeOf<CtxKvClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxKvClient['__errors__']>().not.toBeAny();
  });
});

describe('CtxKvClient — incoming (server outgoing)', () => {
  it('has kv-result with correct shape', () => {
    expectTypeOf<CtxKvClient['incoming']['kv-result']>().toEqualTypeOf<{
      key: string;
      value: string | null;
    }>();
  });

  it('only kv-result in incoming', () => {
    expectTypeOf<keyof CtxKvClient['incoming']>().toEqualTypeOf<'kv-result'>();
  });
});

describe('CtxKvClient — outgoing (server incoming)', () => {
  it('has kv-set', () => {
    expectTypeOf<CtxKvClient['outgoing']['kv-set']>().toEqualTypeOf<{
      key: string;
      value: string;
      ttlMs?: number | undefined;
    }>();
  });

  it('has kv-get', () => {
    expectTypeOf<CtxKvClient['outgoing']['kv-get']>().toEqualTypeOf<{ key: string }>();
  });

  it('has kv-delete', () => {
    expectTypeOf<CtxKvClient['outgoing']['kv-delete']>().toEqualTypeOf<{ key: string }>();
  });

  it('has kv-set-get', () => {
    expectTypeOf<CtxKvClient['outgoing']['kv-set-get']>().toEqualTypeOf<{
      key: string;
      value: string;
    }>();
  });

  it('exactly four events in outgoing', () => {
    expectTypeOf<keyof CtxKvClient['outgoing']>().toEqualTypeOf<
      'kv-set' | 'kv-get' | 'kv-delete' | 'kv-set-get'
    >();
  });
});

describe('CtxKvClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof CtxKvClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof CtxKvClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof CtxKvClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof CtxKvClient['namespaces']>().toBeNever();
  });
});

describe('CtxKvClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<CtxKvClient['__errors__']>().toHaveProperty('validation-failed');
    expectTypeOf<CtxKvClient['__errors__']>().toHaveProperty('channel-not-found');
    expectTypeOf<CtxKvClient['__errors__']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<CtxKvClient['__errors__']>().toHaveProperty('namespace-not-found');
    expectTypeOf<CtxKvClient['__errors__']>().toHaveProperty('internal-error');
  });
});
