import { describe, expectTypeOf, it } from 'vitest';
import type { GroupFullSurfaceClient } from './handler.ts';

describe('GroupFullSurfaceClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['outgoing']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['requests']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['streams']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['channels']>().not.toBeAny();
    expectTypeOf<GroupFullSurfaceClient['namespaces']>().not.toBeAny();
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

  it('has binary-marker', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['binary-marker']>().toEqualTypeOf<{
      size: number;
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

  it('has replay-marker', () => {
    expectTypeOf<GroupFullSurfaceClient['incoming']['replay-marker']>().toEqualTypeOf<{
      note: string;
    }>();
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

  it('has emit-replay-marker', () => {
    expectTypeOf<GroupFullSurfaceClient['outgoing']['emit-replay-marker']>().toEqualTypeOf<{
      note: string;
    }>();
  });
});

describe('GroupFullSurfaceClient — requests', () => {
  it('has lookup', () => {
    expectTypeOf<GroupFullSurfaceClient['requests']>().toHaveProperty('lookup');
  });

  it('lookup has correct payload and response', () => {
    expectTypeOf<GroupFullSurfaceClient['requests']['lookup']['payload']>().toEqualTypeOf<{
      id: string;
    }>();
    expectTypeOf<GroupFullSurfaceClient['requests']['lookup']['response']>().toEqualTypeOf<{
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

  it('feed has no cursor (basic stream)', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']['feed']>().not.toHaveProperty('cursor');
  });

  it('has paginate resumable stream', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']>().toHaveProperty('paginate');
  });

  it('paginate chunk is correct', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']['paginate']['chunk']>().toEqualTypeOf<{
      row: number;
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
    expectTypeOf<GroupFullSurfaceClient['streams']['paginate']>().not.toHaveProperty('broadcast');
    expectTypeOf<GroupFullSurfaceClient['streams']['tokens']>().not.toHaveProperty('broadcast');
  });
});

describe('GroupFullSurfaceClient — stream resumable flags', () => {
  it('feed is not resumable', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']['feed']['resumable']>().toEqualTypeOf<false>();
  });

  it('paginate is resumable', () => {
    expectTypeOf<
      GroupFullSurfaceClient['streams']['paginate']['resumable']
    >().toEqualTypeOf<true>();
  });

  it('tokens is resumable', () => {
    expectTypeOf<GroupFullSurfaceClient['streams']['tokens']['resumable']>().toEqualTypeOf<true>();
  });
});

describe('GroupFullSurfaceClient — channels', () => {
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

describe('GroupFullSurfaceClient — namespaces', () => {
  it('has v1 namespace', () => {
    expectTypeOf<GroupFullSurfaceClient['namespaces']>().toHaveProperty('v1');
  });

  it('v1 incoming has v1-pong (server outgoing)', () => {
    expectTypeOf<
      GroupFullSurfaceClient['namespaces']['v1']['incoming']['v1-pong']
    >().toEqualTypeOf<{}>();
  });

  it('v1 outgoing has v1-ping (server incoming)', () => {
    expectTypeOf<
      GroupFullSurfaceClient['namespaces']['v1']['outgoing']['v1-ping']
    >().toEqualTypeOf<{}>();
  });
});

describe('GroupFullSurfaceClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<GroupFullSurfaceClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<GroupFullSurfaceClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<GroupFullSurfaceClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<GroupFullSurfaceClient['errors']>().toHaveProperty('namespace-not-found');
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
      | 'binary-marker'
      | 'pre-intercept-marker'
      | 'post-intercept-marker'
      | 'rl-marker'
      | 'replay-marker'
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
      | 'emit-replay-marker'
    >();
  });

  it('requests has exactly lookup', () => {
    expectTypeOf<keyof GroupFullSurfaceClient['requests']>().toEqualTypeOf<'lookup'>();
  });

  it('streams has exactly feed, paginate, tokens', () => {
    expectTypeOf<keyof GroupFullSurfaceClient['streams']>().toEqualTypeOf<
      'feed' | 'paginate' | 'tokens'
    >();
  });

  it('channels has exactly rooms', () => {
    expectTypeOf<keyof GroupFullSurfaceClient['channels']>().toEqualTypeOf<'rooms'>();
  });

  it('namespaces has exactly v1', () => {
    expectTypeOf<keyof GroupFullSurfaceClient['namespaces']>().toEqualTypeOf<'v1'>();
  });
});
