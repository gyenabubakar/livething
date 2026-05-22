import { describe, expectTypeOf, it } from 'vitest';
import type { StreamBasicClient } from './handler.ts';

describe('StreamBasicClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<StreamBasicClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['requests']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['streams']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['channels']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['namespaces']>().not.toBeAny();
    expectTypeOf<StreamBasicClient['errors']>().not.toBeAny();
  });
});

describe('StreamBasicClient — incoming (server outgoing)', () => {
  it('has cancel-observed', () => {
    expectTypeOf<StreamBasicClient['incoming']['cancel-observed']>().toEqualTypeOf<{
      cancelled: boolean;
    }>();
  });

  it('only cancel-observed in incoming', () => {
    expectTypeOf<keyof StreamBasicClient['incoming']>().toEqualTypeOf<'cancel-observed'>();
  });
});

describe('StreamBasicClient — outgoing is empty', () => {
  it('outgoing is empty', () => {
    expectTypeOf<keyof StreamBasicClient['outgoing']>().toBeNever();
  });
});

describe('StreamBasicClient — streams', () => {
  it('has start-tokens stream', () => {
    expectTypeOf<StreamBasicClient['streams']>().toHaveProperty('start-tokens');
  });

  it('start-tokens has correct payload and chunk', () => {
    expectTypeOf<StreamBasicClient['streams']['start-tokens']['payload']>().toEqualTypeOf<{
      count: number;
    }>();
    expectTypeOf<StreamBasicClient['streams']['start-tokens']['chunk']>().toEqualTypeOf<{
      index: number;
    }>();
  });

  it('start-tokens has no cursor, nudges, or broadcast', () => {
    expectTypeOf<StreamBasicClient['streams']['start-tokens']>().not.toHaveProperty('cursor');
    expectTypeOf<StreamBasicClient['streams']['start-tokens']>().not.toHaveProperty('nudges');
    expectTypeOf<StreamBasicClient['streams']['start-tokens']>().not.toHaveProperty('broadcast');
  });

  it('has start-boom stream', () => {
    expectTypeOf<StreamBasicClient['streams']>().toHaveProperty('start-boom');
  });

  it('has start-boom-immediate stream', () => {
    expectTypeOf<StreamBasicClient['streams']>().toHaveProperty('start-boom-immediate');
  });

  it('has start-typed-error stream', () => {
    expectTypeOf<StreamBasicClient['streams']>().toHaveProperty('start-typed-error');
  });

  it('has start-cancel-observe stream', () => {
    expectTypeOf<StreamBasicClient['streams']>().toHaveProperty('start-cancel-observe');
  });

  it('has start-empty stream', () => {
    expectTypeOf<StreamBasicClient['streams']>().toHaveProperty('start-empty');
  });

  it('all streams have index chunk', () => {
    expectTypeOf<StreamBasicClient['streams']['start-boom']['chunk']>().toEqualTypeOf<{
      index: number;
    }>();
    expectTypeOf<StreamBasicClient['streams']['start-boom-immediate']['chunk']>().toEqualTypeOf<{
      index: number;
    }>();
    expectTypeOf<StreamBasicClient['streams']['start-typed-error']['chunk']>().toEqualTypeOf<{
      index: number;
    }>();
    expectTypeOf<StreamBasicClient['streams']['start-empty']['chunk']>().toEqualTypeOf<{
      index: number;
    }>();
  });

  it('exactly six streams', () => {
    expectTypeOf<keyof StreamBasicClient['streams']>().toEqualTypeOf<
      | 'start-tokens'
      | 'start-boom'
      | 'start-boom-immediate'
      | 'start-typed-error'
      | 'start-cancel-observe'
      | 'start-empty'
    >();
  });
});

describe('StreamBasicClient — stream resumable flags', () => {
  it('all streams are not resumable', () => {
    expectTypeOf<StreamBasicClient['streams']['start-boom']['resumable']>().toEqualTypeOf<false>();
    expectTypeOf<
      StreamBasicClient['streams']['start-boom-immediate']['resumable']
    >().toEqualTypeOf<false>();
    expectTypeOf<
      StreamBasicClient['streams']['start-cancel-observe']['resumable']
    >().toEqualTypeOf<false>();
    expectTypeOf<StreamBasicClient['streams']['start-empty']['resumable']>().toEqualTypeOf<false>();
    expectTypeOf<
      StreamBasicClient['streams']['start-tokens']['resumable']
    >().toEqualTypeOf<false>();
    expectTypeOf<
      StreamBasicClient['streams']['start-typed-error']['resumable']
    >().toEqualTypeOf<false>();
  });
});

describe('StreamBasicClient — declared errors', () => {
  it('has not-found error with id detail', () => {
    expectTypeOf<StreamBasicClient['errors']['not-found']>().toEqualTypeOf<{ id: string }>();
  });
});

describe('StreamBasicClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<StreamBasicClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<StreamBasicClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<StreamBasicClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<StreamBasicClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<StreamBasicClient['errors']>().toHaveProperty('internal-error');
  });
});
