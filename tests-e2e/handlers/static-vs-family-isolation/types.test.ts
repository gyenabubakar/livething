import { describe, expectTypeOf, it } from 'vitest';
import type { StaticVsFamilyIsolationClient } from './handler.ts';

describe('StaticVsFamilyIsolationClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['incoming']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['outgoing']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['requests']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['streams']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['channels']>().not.toBeAny();
    expectTypeOf<StaticVsFamilyIsolationClient['errors']>().not.toBeAny();
  });
});

describe('StaticVsFamilyIsolationClient — incoming (server outgoing)', () => {
  it('has tag-ack', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['incoming']['tag-ack']>().toEqualTypeOf<{
      tag: string;
    }>();
  });

  it('has observe-result', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['incoming']['observe-result']>().toEqualTypeOf<{
      where: string;
      name: string;
      count: number;
    }>();
  });

  it('has kick-ack', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['incoming']['kick-ack']>().toEqualTypeOf<{
      where: string;
    }>();
  });

  it('exactly three events in top-level incoming', () => {
    expectTypeOf<keyof StaticVsFamilyIsolationClient['incoming']>().toEqualTypeOf<
      'tag-ack' | 'observe-result' | 'kick-ack'
    >();
  });
});

describe('StaticVsFamilyIsolationClient — outgoing (server incoming)', () => {
  it('has tag-self', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['outgoing']['tag-self']>().toEqualTypeOf<{
      tag: string;
    }>();
  });

  it('has observe-static', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['outgoing']['observe-static']>().toEqualTypeOf<{
      name: string;
    }>();
  });

  it('has observe-family', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['outgoing']['observe-family']>().toEqualTypeOf<{
      name: string;
    }>();
  });

  it('has kick-static', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['outgoing']['kick-static']>().toEqualTypeOf<{
      name: string;
      tag: string;
      reason: string;
    }>();
  });

  it('has kick-family', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['outgoing']['kick-family']>().toEqualTypeOf<{
      name: string;
      tag: string;
      reason: string;
    }>();
  });
});

describe('StaticVsFamilyIsolationClient — channels', () => {
  it('has general channel', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['channels']>().toHaveProperty('general');
  });

  it('has rooms channel', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['channels']>().toHaveProperty('rooms');
  });

  it('addressing discriminator: static general is static, scope() rooms is dynamic', () => {
    expectTypeOf<
      StaticVsFamilyIsolationClient['channels']['general']['addressing']
    >().toEqualTypeOf<'static'>();
    expectTypeOf<
      StaticVsFamilyIsolationClient['channels']['rooms']['addressing']
    >().toEqualTypeOf<'dynamic'>();
  });

  it('general incoming has msg (server outgoing)', () => {
    expectTypeOf<
      StaticVsFamilyIsolationClient['channels']['general']['incoming']['msg']
    >().toEqualTypeOf<{
      from: string;
      text: string;
    }>();
  });

  it('general outgoing has send-in-general (server incoming)', () => {
    expectTypeOf<
      StaticVsFamilyIsolationClient['channels']['general']['outgoing']['send-in-general']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('rooms incoming has msg', () => {
    expectTypeOf<
      StaticVsFamilyIsolationClient['channels']['rooms']['incoming']['msg']
    >().toEqualTypeOf<{
      from: string;
      text: string;
    }>();
  });

  it('rooms outgoing has send-in-room', () => {
    expectTypeOf<
      StaticVsFamilyIsolationClient['channels']['rooms']['outgoing']['send-in-room']
    >().toEqualTypeOf<{
      name: string;
      text: string;
    }>();
  });
});

describe('StaticVsFamilyIsolationClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof StaticVsFamilyIsolationClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof StaticVsFamilyIsolationClient['streams']>().toBeNever();
  });
});

describe('StaticVsFamilyIsolationClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<StaticVsFamilyIsolationClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<StaticVsFamilyIsolationClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<StaticVsFamilyIsolationClient['errors']>().toHaveProperty(
      'channel-not-subscribed',
    );
    expectTypeOf<StaticVsFamilyIsolationClient['errors']>().toHaveProperty('internal-error');
  });
});
