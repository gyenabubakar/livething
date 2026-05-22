import { describe, expectTypeOf, it } from 'vitest';
import type { CtxQualityClient } from './handler.ts';

describe('CtxQualityClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<CtxQualityClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['requests']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['streams']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['channels']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxQualityClient['errors']>().not.toBeAny();
  });
});

describe('CtxQualityClient — incoming (server outgoing)', () => {
  it('has quality-result with correct shape', () => {
    expectTypeOf<CtxQualityClient['incoming']['quality-result']>().toEqualTypeOf<{
      quality: string;
      latency: number | null;
      bufferedAmount: number;
    }>();
  });

  it('only quality-result in incoming', () => {
    expectTypeOf<keyof CtxQualityClient['incoming']>().toEqualTypeOf<'quality-result'>();
  });
});

describe('CtxQualityClient — outgoing (server incoming)', () => {
  it('has get-quality with empty payload', () => {
    expectTypeOf<CtxQualityClient['outgoing']['get-quality']>().toEqualTypeOf<{}>();
  });

  it('only get-quality in outgoing', () => {
    expectTypeOf<keyof CtxQualityClient['outgoing']>().toEqualTypeOf<'get-quality'>();
  });
});

describe('CtxQualityClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof CtxQualityClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof CtxQualityClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof CtxQualityClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof CtxQualityClient['namespaces']>().toBeNever();
  });
});

describe('CtxQualityClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<CtxQualityClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<CtxQualityClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<CtxQualityClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<CtxQualityClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<CtxQualityClient['errors']>().toHaveProperty('internal-error');
  });
});
