import { describe, expectTypeOf, it } from 'vitest';
import type { StreamDurableClient } from './handler.ts';

describe('StreamDurableClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<StreamDurableClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamDurableClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamDurableClient['requests']>().not.toBeAny();
    expectTypeOf<StreamDurableClient['streams']>().not.toBeAny();
    expectTypeOf<StreamDurableClient['channels']>().not.toBeAny();
    expectTypeOf<StreamDurableClient['namespaces']>().not.toBeAny();
    expectTypeOf<StreamDurableClient['__errors__']>().not.toBeAny();
  });
});

describe('StreamDurableClient — streams', () => {
  it('has count-tokens (recordedStream)', () => {
    expectTypeOf<StreamDurableClient['streams']>().toHaveProperty('count-tokens');
  });

  it('count-tokens has correct payload and chunk', () => {
    expectTypeOf<StreamDurableClient['streams']['count-tokens']['payload']>().toEqualTypeOf<{}>();
    expectTypeOf<StreamDurableClient['streams']['count-tokens']['chunk']>().toEqualTypeOf<{
      idx: number;
    }>();
  });

  it('count-tokens has no cursor (recordedStream does not have a cursor validator)', () => {
    expectTypeOf<StreamDurableClient['streams']['count-tokens']>().not.toHaveProperty('cursor');
  });

  it('count-tokens has no nudges or broadcast key', () => {
    expectTypeOf<StreamDurableClient['streams']['count-tokens']>().not.toHaveProperty('nudges');
    expectTypeOf<StreamDurableClient['streams']['count-tokens']>().not.toHaveProperty('broadcast');
  });

  it('has paginate (resumableStream)', () => {
    expectTypeOf<StreamDurableClient['streams']>().toHaveProperty('paginate');
  });

  it('paginate has correct payload and chunk', () => {
    expectTypeOf<StreamDurableClient['streams']['paginate']['payload']>().toEqualTypeOf<{}>();
    expectTypeOf<StreamDurableClient['streams']['paginate']['chunk']>().toEqualTypeOf<{
      row: number;
    }>();
  });

  it('paginate has no cursor (no cursor validator declared in resumableStream config)', () => {
    expectTypeOf<StreamDurableClient['streams']['paginate']>().not.toHaveProperty('cursor');
  });

  it('has attempt-stream (resumableStream)', () => {
    expectTypeOf<StreamDurableClient['streams']>().toHaveProperty('attempt-stream');
  });

  it('attempt-stream chunk is correct', () => {
    expectTypeOf<StreamDurableClient['streams']['attempt-stream']['chunk']>().toEqualTypeOf<{
      attempt: number;
    }>();
  });

  it('has buffer-full-demo (recordedStream)', () => {
    expectTypeOf<StreamDurableClient['streams']>().toHaveProperty('buffer-full-demo');
  });

  it('buffer-full-demo chunk is correct', () => {
    expectTypeOf<StreamDurableClient['streams']['buffer-full-demo']['chunk']>().toEqualTypeOf<{
      n: number;
    }>();
  });

  it('exactly four streams', () => {
    expectTypeOf<keyof StreamDurableClient['streams']>().toEqualTypeOf<
      'count-tokens' | 'paginate' | 'attempt-stream' | 'buffer-full-demo'
    >();
  });
});

describe('StreamDurableClient — empty slots', () => {
  it('incoming is empty', () => {
    expectTypeOf<keyof StreamDurableClient['incoming']>().toBeNever();
  });

  it('outgoing is empty', () => {
    expectTypeOf<keyof StreamDurableClient['outgoing']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof StreamDurableClient['requests']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof StreamDurableClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof StreamDurableClient['namespaces']>().toBeNever();
  });
});

describe('StreamDurableClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<StreamDurableClient['__errors__']>().toHaveProperty('validation-failed');
    expectTypeOf<StreamDurableClient['__errors__']>().toHaveProperty('channel-not-found');
    expectTypeOf<StreamDurableClient['__errors__']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<StreamDurableClient['__errors__']>().toHaveProperty('namespace-not-found');
    expectTypeOf<StreamDurableClient['__errors__']>().toHaveProperty('internal-error');
  });
});
