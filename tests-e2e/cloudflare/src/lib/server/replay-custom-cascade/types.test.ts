import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayCustomCascadeClient } from './handler.ts';

describe('ReplayCustomCascadeClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ReplayCustomCascadeClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['requests']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['streams']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['channels']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplayCustomCascadeClient['__errors__']>().not.toBeAny();
  });
});

describe('ReplayCustomCascadeClient — top-level slots are empty', () => {
  it('top-level incoming is empty', () => {
    expectTypeOf<keyof ReplayCustomCascadeClient['incoming']>().toBeNever();
  });

  it('top-level outgoing is empty', () => {
    expectTypeOf<keyof ReplayCustomCascadeClient['outgoing']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof ReplayCustomCascadeClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ReplayCustomCascadeClient['streams']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof ReplayCustomCascadeClient['namespaces']>().toBeNever();
  });
});

describe('ReplayCustomCascadeClient — channels', () => {
  it('has lobby channel', () => {
    expectTypeOf<ReplayCustomCascadeClient['channels']>().toHaveProperty('lobby');
  });

  it('has rooms channel', () => {
    expectTypeOf<ReplayCustomCascadeClient['channels']>().toHaveProperty('rooms');
  });

  it('lobby incoming has note (server outgoing)', () => {
    expectTypeOf<
      ReplayCustomCascadeClient['channels']['lobby']['incoming']['note']
    >().toEqualTypeOf<{ text: string }>();
  });

  it('lobby outgoing has send-note (server incoming)', () => {
    expectTypeOf<
      ReplayCustomCascadeClient['channels']['lobby']['outgoing']['send-note']
    >().toEqualTypeOf<{ text: string }>();
  });

  it('rooms incoming has note', () => {
    expectTypeOf<
      ReplayCustomCascadeClient['channels']['rooms']['incoming']['note']
    >().toEqualTypeOf<{ text: string }>();
  });

  it('rooms outgoing has send-note', () => {
    expectTypeOf<
      ReplayCustomCascadeClient['channels']['rooms']['outgoing']['send-note']
    >().toEqualTypeOf<{ text: string }>();
  });
});

describe('ReplayCustomCascadeClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ReplayCustomCascadeClient['__errors__']>().toHaveProperty('validation-failed');
    expectTypeOf<ReplayCustomCascadeClient['__errors__']>().toHaveProperty('channel-not-found');
    expectTypeOf<ReplayCustomCascadeClient['__errors__']>().toHaveProperty(
      'channel-not-subscribed',
    );
    expectTypeOf<ReplayCustomCascadeClient['__errors__']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ReplayCustomCascadeClient['__errors__']>().toHaveProperty('internal-error');
  });
});
