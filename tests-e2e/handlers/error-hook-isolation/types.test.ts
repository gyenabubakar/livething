import { describe, expectTypeOf, it } from 'vitest';
import type { ErrorHookIsolationClient } from './handler.ts';

describe('ErrorHookIsolationClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ErrorHookIsolationClient['incoming']>().not.toBeAny();
    expectTypeOf<ErrorHookIsolationClient['outgoing']>().not.toBeAny();
    expectTypeOf<ErrorHookIsolationClient['clientRequests']>().not.toBeAny();
    expectTypeOf<ErrorHookIsolationClient['streams']>().not.toBeAny();
    expectTypeOf<ErrorHookIsolationClient['channels']>().not.toBeAny();

    expectTypeOf<ErrorHookIsolationClient['errors']>().not.toBeAny();
  });
});

describe('ErrorHookIsolationClient — clientRequests', () => {
  it('has do-request', () => {
    expectTypeOf<ErrorHookIsolationClient['clientRequests']>().toHaveProperty('do-request');
  });

  it('do-request has correct payload', () => {
    expectTypeOf<
      ErrorHookIsolationClient['clientRequests']['do-request']['payload']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('do-request has correct response', () => {
    expectTypeOf<
      ErrorHookIsolationClient['clientRequests']['do-request']['response']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('only do-request in clientRequests', () => {
    expectTypeOf<keyof ErrorHookIsolationClient['clientRequests']>().toEqualTypeOf<'do-request'>();
  });
});

describe('ErrorHookIsolationClient — empty slots', () => {
  it('incoming is empty', () => {
    expectTypeOf<keyof ErrorHookIsolationClient['incoming']>().toBeNever();
  });

  it('outgoing is empty', () => {
    expectTypeOf<keyof ErrorHookIsolationClient['outgoing']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ErrorHookIsolationClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof ErrorHookIsolationClient['channels']>().toBeNever();
  });
});

describe('ErrorHookIsolationClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ErrorHookIsolationClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ErrorHookIsolationClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ErrorHookIsolationClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ErrorHookIsolationClient['errors']>().toHaveProperty('internal-error');
  });
});
