import { describe, expectTypeOf, it } from 'vitest';
import type { GroupFullSurfaceClient } from './handler.ts';

describe('GroupFullSurfaceClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['outgoing']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['clientRequests']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['streams']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['channels']>().not.toBeAny();

    expectTypeOf<GroupFullSurfaceClient['errors']>().not.toBeAny();
  });
});

describe('GroupFullSurfaceClient — incoming (server outgoing)', () => {
  it('has welcome', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['welcome']>().toEqualTypeOf<{
      username: string;
    }>();
  });

  it('has goodbye', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['goodbye']>().toEqualTypeOf<{
      username: string;
    }>();
  });

  it('has init-marker', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['init-marker']>().toEqualTypeOf<{
      ran: number;
    }>();
  });

  it('has error-marker', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['error-marker']>().toEqualTypeOf<{
      event?: string | undefined;
      msg: string;
    }>();
  });

  it('has validation-marker', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['validation-marker']>().toEqualTypeOf<{
      event: string;
    }>();
  });

  it('has pre-intercept-marker', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['pre-intercept-marker']>().toEqualTypeOf<{
      event: string;
    }>();
  });

  it('has post-intercept-marker', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['post-intercept-marker']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('has rl-marker', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['rl-marker']>().toEqualTypeOf<{ at: number }>();
  });

  it('has scheduled-marker', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['scheduled-marker']>().toEqualTypeOf<{
      tickCount: number;
    }>();
  });
});

describe('GroupFullSurfaceClient — outgoing (server incoming)', () => {
  it('has chat', () => {
    expectTypeOf<GroupFullSurfaceClient['outgoing']['chat']>().toEqualTypeOf<{ text: string }>();
  });

  it('has bang with empty payload', () => {
    expectTypeOf<GroupFullSurfaceClient['outgoing']['bang']>().toEqualTypeOf<{}>();
  });

  it('has bad-payload', () => {
    expectTypeOf<GroupFullSurfaceClient['outgoing']['bad-payload']>().toEqualTypeOf<{
      ok: true;
    }>();
  });

  it('has check-init with empty payload', () => {
    expectTypeOf<GroupFullSurfaceClient['outgoing']['check-init']>().toEqualTypeOf<{}>();
  });

  it('has check-disconnect-log', () => {
    expectTypeOf<GroupFullSurfaceClient['outgoing']['check-disconnect-log']>().toEqualTypeOf<{
      identity: string;
    }>();
  });

  it('has check-scheduled with empty payload', () => {
    expectTypeOf<GroupFullSurfaceClient['outgoing']['check-scheduled']>().toEqualTypeOf<{}>();
  });

  it('has start-tick with empty payload', () => {
    expectTypeOf<GroupFullSurfaceClient['outgoing']['start-tick']>().toEqualTypeOf<{}>();
  });
});

describe('GroupFullSurfaceClient — clientRequests', () => {
  it('has lookup', () => {
    expectTypeOf<GroupFullSurfaceClient['clientRequests']>().toHaveProperty('lookup');
  });

  it('lookup has correct payload and response', () => {
    expectTypeOf<GroupFullSurfaceClient['clientRequests']['lookup']['payload']>().toEqualTypeOf<{
      id: string;
    }>();
    expectTypeOf<GroupFullSurfaceClient['clientRequests']['lookup']['response']>().toEqualTypeOf<{
      found: boolean;
      hit: string;
      tag: string;
    }>();
  });
});

describe('GroupFullSurfaceClient — streams', () => {
  it('has feed stream', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']>().toHaveProperty('feed');
  });

  it('feed has correct payload and chunk', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']['feed']['payload']>().toEqualTypeOf<{}>();
    expectTypeOf<GroupFullSurfaceClient['streams']['feed']['chunk']>().toEqualTypeOf<{
      idx: number;
    }>();
  });

  it('has tokens recorded stream', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']>().toHaveProperty('tokens');
  });

  it('tokens chunk is correct', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']['tokens']['chunk']>().toEqualTypeOf<{
      token: string;
    }>();
  });

  it('no stream entry has a broadcast key', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']['feed']>().not.toHaveProperty('broadcast');
    expectTypeOf<GroupFullSurfaceClient['streams']['tokens']>().not.toHaveProperty('broadcast');
  });
});

describe('GroupFullSurfaceClient — stream kind', () => {
  it('feed is ephemeral', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']['feed']['kind']>().toEqualTypeOf<'ephemeral'>();
  });

  it('tokens is persistent', () => {
    expectTypeOf<
      GroupFullSurfaceClient['streams']['tokens']['kind']
    >().toEqualTypeOf<'persistent'>();
  });
});

describe('GroupFullSurfaceClient — channels', () => {
  it('addressing: rooms is a static channel', () => {
    expectTypeOf<
      GroupFullSurfaceClient['channels']['rooms']['addressing']
    >().toEqualTypeOf<'static'>();
  });

  it('has rooms channel', () => {
    expectTypeOf<GroupFullSurfaceClient['channels']>().toHaveProperty('rooms');
  });

  it('rooms incoming has room-msg (server outgoing)', () => {
    expectTypeOf<
      GroupFullSurfaceClient['channels']['rooms']['incoming']['room-msg']
    >().toEqualTypeOf<{
      text: string;
      from: string;
    }>();
  });

  it('rooms outgoing has send-msg (server incoming)', () => {
    expectTypeOf<
      GroupFullSurfaceClient['channels']['rooms']['outgoing']['send-msg']
    >().toEqualTypeOf<{
      text: string;
    }>();
  });
});

describe('GroupFullSurfaceClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<GroupFullSurfaceClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<GroupFullSurfaceClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<GroupFullSurfaceClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<GroupFullSurfaceClient['errors']>().toHaveProperty('internal-error');
  });
});

describe('GroupFullSurfaceClient — exact key sets', () => {
  it('incoming has exactly the declared events', () => {
    expectTypeOf<keyof GroupFullSurfaceClient['incoming']>().toEqualTypeOf<
      | 'welcome'
      | 'goodbye'
      | 'init-marker'
      | 'error-marker'
      | 'validation-marker'
      | 'pre-intercept-marker'
      | 'post-intercept-marker'
      | 'rl-marker'
      | 'scheduled-marker'
    >();
  });

  it('outgoing has exactly the declared events', () => {
    expectTypeOf<keyof GroupFullSurfaceClient['outgoing']>().toEqualTypeOf<
      | 'chat'
      | 'bang'
      | 'bad-payload'
      | 'check-init'
      | 'check-disconnect-log'
      | 'check-scheduled'
      | 'start-tick'
    >();
  });

  it('clientRequests has exactly lookup', () => {
    expectTypeOf<keyof GroupFullSurfaceClient['clientRequests']>().toEqualTypeOf<'lookup'>();
  });

  it('streams has exactly feed, tokens', () => {
    expectTypeOf<keyof GroupFullSurfaceClient['streams']>().toEqualTypeOf<'feed' | 'tokens'>();
  });

  it('channels has exactly rooms', () => {
    expectTypeOf<keyof GroupFullSurfaceClient['channels']>().toEqualTypeOf<'rooms'>();
  });
});
