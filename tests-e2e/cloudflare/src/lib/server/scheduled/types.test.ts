import { describe, expectTypeOf, it } from 'vitest';
import type { ScheduledClient } from './handler.ts';

describe('ScheduledClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ScheduledClient['incoming']>().not.toBeAny();
    expectTypeOf<ScheduledClient['outgoing']>().not.toBeAny();
    expectTypeOf<ScheduledClient['requests']>().not.toBeAny();
    expectTypeOf<ScheduledClient['streams']>().not.toBeAny();
    expectTypeOf<ScheduledClient['channels']>().not.toBeAny();
    expectTypeOf<ScheduledClient['namespaces']>().not.toBeAny();
    expectTypeOf<ScheduledClient['errors']>().not.toBeAny();
  });
});

describe('ScheduledClient — incoming (server outgoing)', () => {
  it('has cleanup-done', () => {
    expectTypeOf<ScheduledClient['incoming']['cleanup-done']>().toEqualTypeOf<{ at: number }>();
  });

  it('has cleanup-cancelled with empty payload', () => {
    expectTypeOf<ScheduledClient['incoming']['cleanup-cancelled']>().toEqualTypeOf<{}>();
  });

  it('has heartbeat-tick', () => {
    expectTypeOf<ScheduledClient['incoming']['heartbeat-tick']>().toEqualTypeOf<{
      count: number;
    }>();
  });

  it('has flaky-task-result', () => {
    expectTypeOf<ScheduledClient['incoming']['flaky-task-result']>().toEqualTypeOf<{
      attempts: number;
    }>();
  });

  it('has default-retry-result', () => {
    expectTypeOf<ScheduledClient['incoming']['default-retry-result']>().toEqualTypeOf<{
      attempts: number;
    }>();
  });

  it('has dead-letter-result', () => {
    expectTypeOf<ScheduledClient['incoming']['dead-letter-result']>().toEqualTypeOf<{
      taskId: string;
      attempts: number;
      error: string;
    }>();
  });

  it('has filtered-task-result', () => {
    expectTypeOf<ScheduledClient['incoming']['filtered-task-result']>().toEqualTypeOf<{
      label: string;
    }>();
  });

  it('has cancel-nothing-ok with empty payload', () => {
    expectTypeOf<ScheduledClient['incoming']['cancel-nothing-ok']>().toEqualTypeOf<{}>();
  });

  it('has schedule-guard-error', () => {
    expectTypeOf<ScheduledClient['incoming']['schedule-guard-error']>().toEqualTypeOf<{
      message: string;
    }>();
  });

  it('has who-am-i-result', () => {
    expectTypeOf<ScheduledClient['incoming']['who-am-i-result']>().toEqualTypeOf<{
      connectionId: string;
    }>();
  });

  it('has broadcast-result', () => {
    expectTypeOf<ScheduledClient['incoming']['broadcast-result']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('has send-to-tag-result', () => {
    expectTypeOf<ScheduledClient['incoming']['send-to-tag-result']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('has cancel-nonexistent-ok with empty payload', () => {
    expectTypeOf<ScheduledClient['incoming']['cancel-nonexistent-ok']>().toEqualTypeOf<{}>();
  });

  it('has schedule-unknown-task-result', () => {
    expectTypeOf<ScheduledClient['incoming']['schedule-unknown-task-result']>().toEqualTypeOf<{
      rejected: boolean;
      message: string;
    }>();
  });

  it('has schedule-send-to-conn-delivery', () => {
    expectTypeOf<ScheduledClient['incoming']['schedule-send-to-conn-delivery']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('has schedule-send-to-conn-status', () => {
    expectTypeOf<ScheduledClient['incoming']['schedule-send-to-conn-status']>().toEqualTypeOf<{
      connectionId: string;
      delivered: boolean;
    }>();
  });
});

describe('ScheduledClient — outgoing (server incoming)', () => {
  it('has schedule-cleanup', () => {
    expectTypeOf<ScheduledClient['outgoing']['schedule-cleanup']>().toEqualTypeOf<{
      delayMs: number;
    }>();
  });

  it('has cancel-cleanup with empty payload', () => {
    expectTypeOf<ScheduledClient['outgoing']['cancel-cleanup']>().toEqualTypeOf<{}>();
  });

  it('has start-heartbeat with empty payload', () => {
    expectTypeOf<ScheduledClient['outgoing']['start-heartbeat']>().toEqualTypeOf<{}>();
  });

  it('has trigger-flaky-task with empty payload', () => {
    expectTypeOf<ScheduledClient['outgoing']['trigger-flaky-task']>().toEqualTypeOf<{}>();
  });

  it('has who-am-i with empty payload', () => {
    expectTypeOf<ScheduledClient['outgoing']['who-am-i']>().toEqualTypeOf<{}>();
  });
});

describe('ScheduledClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof ScheduledClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof ScheduledClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof ScheduledClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof ScheduledClient['namespaces']>().toBeNever();
  });
});

describe('ScheduledClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ScheduledClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ScheduledClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ScheduledClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ScheduledClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ScheduledClient['errors']>().toHaveProperty('internal-error');
  });
});
