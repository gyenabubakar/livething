import { describe, expectTypeOf, it } from 'vitest';
import type { CtxKvClient } from './handler.ts';

describe('CtxKvClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<CtxKvClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxKvClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxKvClient['clientRequests']>().not.toBeAny();
    expectTypeOf<CtxKvClient['streams']>().not.toBeAny();
    expectTypeOf<CtxKvClient['channels']>().not.toBeAny();
    expectTypeOf<CtxKvClient['errors']>().not.toBeAny();
  });
});

describe('CtxKvClient — incoming (server outgoing)', () => {
  it('has kv-result with correct shape', () => {
    expectTypeOf<CtxKvClient['incoming']['kv-result']>().toEqualTypeOf<{
      key: string;
      value: string | null;
    }>();
  });

  it('has the declared incoming events', () => {
    expectTypeOf<keyof CtxKvClient['incoming']>().toEqualTypeOf<'kv-result' | 'kv-list-result'>();
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

  it('has the declared outgoing events', () => {
    expectTypeOf<keyof CtxKvClient['outgoing']>().toEqualTypeOf<
      'kv-set' | 'kv-get' | 'kv-delete' | 'kv-set-get' | 'kv-list-probe' | 'kv-ttl-zero-probe'
    >();
  });
});

describe('CtxKvClient — empty slots', () => {
  it('clientRequests is empty', () => {
    expectTypeOf<keyof CtxKvClient['clientRequests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof CtxKvClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof CtxKvClient['channels']>().toBeNever();
  });
});

describe('CtxKvClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<CtxKvClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<CtxKvClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<CtxKvClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<CtxKvClient['errors']>().toHaveProperty('internal-error');
  });
});
