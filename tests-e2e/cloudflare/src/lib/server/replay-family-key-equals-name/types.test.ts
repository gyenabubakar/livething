import { describe, expectTypeOf, it } from 'vitest';
import type { ReplayFamilyKeyEqualsNameClient } from './handler.ts';

describe('ReplayFamilyKeyEqualsNameClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['incoming']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['outgoing']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['requests']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['streams']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['channels']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['namespaces']>().not.toBeAny();
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['__errors__']>().not.toBeAny();
  });
});

describe('ReplayFamilyKeyEqualsNameClient — top-level slots are empty', () => {
  it('top-level incoming is empty', () => {
    expectTypeOf<keyof ReplayFamilyKeyEqualsNameClient['incoming']>().toBeNever();
  });

  it('top-level outgoing is empty', () => {
    expectTypeOf<keyof ReplayFamilyKeyEqualsNameClient['outgoing']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof ReplayFamilyKeyEqualsNameClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ReplayFamilyKeyEqualsNameClient['streams']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof ReplayFamilyKeyEqualsNameClient['namespaces']>().toBeNever();
  });
});

describe('ReplayFamilyKeyEqualsNameClient — channels', () => {
  it('has rooms channel', () => {
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['channels']>().toHaveProperty('rooms');
  });

  it('rooms incoming has room-message (server outgoing)', () => {
    expectTypeOf<
      ReplayFamilyKeyEqualsNameClient['channels']['rooms']['incoming']['room-message']
    >().toEqualTypeOf<{ text: string }>();
  });

  it('rooms outgoing has send-batch (server incoming)', () => {
    expectTypeOf<
      ReplayFamilyKeyEqualsNameClient['channels']['rooms']['outgoing']['send-batch']
    >().toEqualTypeOf<{ count: number }>();
  });
});

describe('ReplayFamilyKeyEqualsNameClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['__errors__']>().toHaveProperty(
      'validation-failed',
    );
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['__errors__']>().toHaveProperty(
      'channel-not-found',
    );
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['__errors__']>().toHaveProperty(
      'channel-not-subscribed',
    );
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['__errors__']>().toHaveProperty(
      'namespace-not-found',
    );
    expectTypeOf<ReplayFamilyKeyEqualsNameClient['__errors__']>().toHaveProperty('internal-error');
  });
});
