import { describe, expectTypeOf, it } from 'vitest';
import type { StreamNudgesClient } from './handler.ts';

describe('StreamNudgesClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<StreamNudgesClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['clientRequests']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['streams']>().not.toBeAny();
    expectTypeOf<StreamNudgesClient['channels']>().not.toBeAny();

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

  it('has held-stream-released', () => {
    expectTypeOf<StreamNudgesClient['incoming']['held-stream-released']>().toEqualTypeOf<
      Record<string, never>
    >();
  });

  it('has exactly the declared incoming events', () => {
    expectTypeOf<keyof StreamNudgesClient['incoming']>().toEqualTypeOf<
      'held-stream-released' | 'pause-top-level-fired' | 'nudge-saw'
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
    expectTypeOf<keyof StreamNudgesClient['outgoing']>().toEqualTypeOf<
      'pause' | 'release-overflow'
    >();
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

  it('start-nudge-stream has no broadcast key', () => {
    expectTypeOf<StreamNudgesClient['streams']['start-nudge-stream']>().not.toHaveProperty(
      'broadcast',
    );
  });

  it('only start-nudge-stream in streams', () => {
    expectTypeOf<keyof StreamNudgesClient['streams']>().toEqualTypeOf<'start-nudge-stream'>();
  });
});

describe('StreamNudgesClient — stream kind', () => {
  it('start-nudge-stream is ephemeral', () => {
    expectTypeOf<
      StreamNudgesClient['streams']['start-nudge-stream']['kind']
    >().toEqualTypeOf<'ephemeral'>();
  });
});

describe('StreamNudgesClient — empty slots', () => {
  it('clientRequests is empty', () => {
    expectTypeOf<keyof StreamNudgesClient['clientRequests']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof StreamNudgesClient['channels']>().toBeNever();
  });
});

describe('StreamNudgesClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<StreamNudgesClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<StreamNudgesClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<StreamNudgesClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<StreamNudgesClient['errors']>().toHaveProperty('internal-error');
  });
});
