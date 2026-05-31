import { describe, expectTypeOf, it } from 'vitest';
import type { StreamNudgesClient } from './handler.ts';

describe('StreamNudgesClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<StreamNudgesClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['requests']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['streams']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['channels']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['namespaces']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['errors']>().not.toBeAny();
  });
});

describe('StreamNudgesClient — incoming (server outgoing)', () => {
  it('has pause-top-level-fired', () => {
    expectTypeOf<StreamNudgesClient['incoming']['pause-top-level-fired']>().toEqualTypeOf<{
      leak: string;
    }>();
  });

  it('has nudge-saw', () => {
    expectTypeOf<StreamNudgesClient['incoming']['nudge-saw']>().toEqualTypeOf<{
      events: string[];
    }>();
  });

  it('exactly two events in incoming', () => {
    expectTypeOf<keyof StreamNudgesClient['incoming']>().toEqualTypeOf<
      'pause-top-level-fired' | 'nudge-saw'
    >();
  });
});

describe('StreamNudgesClient — outgoing (server incoming)', () => {
  it('has pause', () => {
    expectTypeOf<StreamNudgesClient['outgoing']['pause']>().toEqualTypeOf<{
      leak?: string | undefined;
    }>();
  });

  it('only pause in outgoing', () => {
    expectTypeOf<keyof StreamNudgesClient['outgoing']>().toEqualTypeOf<'pause'>();
  });
});

describe('StreamNudgesClient — streams', () => {
  it('has start-nudge-stream', () => {
    expectTypeOf<StreamNudgesClient['streams']>().toHaveProperty('start-nudge-stream');
  });

  it('start-nudge-stream has correct payload', () => {
    expectTypeOf<StreamNudgesClient['streams']['start-nudge-stream']['payload']>().toEqualTypeOf<{
      prompt: string;
    }>();
  });

  it('start-nudge-stream has correct chunk', () => {
    expectTypeOf<StreamNudgesClient['streams']['start-nudge-stream']['chunk']>().toEqualTypeOf<{
      token: string;
    }>();
  });

  it('start-nudge-stream has nudges (declared nudges)', () => {
    expectTypeOf<StreamNudgesClient['streams']['start-nudge-stream']>().toHaveProperty('nudges');
  });

  it('start-nudge-stream has no cursor (basic stream)', () => {
    expectTypeOf<StreamNudgesClient['streams']['start-nudge-stream']>().not.toHaveProperty(
      'cursor',
    );
  });

  it('start-nudge-stream has no broadcast key', () => {
    expectTypeOf<StreamNudgesClient['streams']['start-nudge-stream']>().not.toHaveProperty(
      'broadcast',
    );
  });

  it('only start-nudge-stream in streams', () => {
    expectTypeOf<keyof StreamNudgesClient['streams']>().toEqualTypeOf<'start-nudge-stream'>();
  });
});

describe('StreamNudgesClient — stream resumable flags', () => {
  it('start-nudge-stream is not resumable', () => {
    expectTypeOf<
      StreamNudgesClient['streams']['start-nudge-stream']['resumable']
    >().toEqualTypeOf<false>();
  });
});

describe('StreamNudgesClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof StreamNudgesClient['requests']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof StreamNudgesClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof StreamNudgesClient['namespaces']>().toBeNever();
  });
});

describe('StreamNudgesClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<StreamNudgesClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<StreamNudgesClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<StreamNudgesClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<StreamNudgesClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<StreamNudgesClient['errors']>().toHaveProperty('internal-error');
  });
});
