import { describe, expectTypeOf, it } from 'vitest';
import type { ModulesClient } from './handler.ts';

describe('ModulesClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ModulesClient['incoming']>().not.toBeAny();
    expectTypeOf<ModulesClient['outgoing']>().not.toBeAny();
    expectTypeOf<ModulesClient['requests']>().not.toBeAny();
    expectTypeOf<ModulesClient['streams']>().not.toBeAny();
    expectTypeOf<ModulesClient['channels']>().not.toBeAny();
    expectTypeOf<ModulesClient['namespaces']>().not.toBeAny();
    expectTypeOf<ModulesClient['errors']>().not.toBeAny();
  });
});

describe('ModulesClient — incoming (server outgoing)', () => {
  it('has record-inserted', () => {
    expectTypeOf<ModulesClient['incoming']['record-inserted']>().toEqualTypeOf<{ id: number }>();
  });

  it('has record-count', () => {
    expectTypeOf<ModulesClient['incoming']['record-count']>().toEqualTypeOf<{ count: number }>();
  });

  it('has message-count', () => {
    expectTypeOf<ModulesClient['incoming']['message-count']>().toEqualTypeOf<{ count: number }>();
  });

  it('has generated-id', () => {
    expectTypeOf<ModulesClient['incoming']['generated-id']>().toEqualTypeOf<{
      value: string | null;
    }>();
  });

  it('has module-rewrite-result', () => {
    expectTypeOf<ModulesClient['incoming']['module-rewrite-result']>().toEqualTypeOf<{
      text: string;
      rewritten?: boolean | undefined;
    }>();
  });

  it('has module-every-tick', () => {
    expectTypeOf<ModulesClient['incoming']['module-every-tick']>().toEqualTypeOf<{
      count: number;
    }>();
  });

  it('has module-flaky-result', () => {
    expectTypeOf<ModulesClient['incoming']['module-flaky-result']>().toEqualTypeOf<{
      attempts: number;
    }>();
  });

  it('has module-dlq-result', () => {
    expectTypeOf<ModulesClient['incoming']['module-dlq-result']>().toEqualTypeOf<{
      taskId: string;
      attempts: number;
      error: string;
    }>();
  });

  it('has error-result', () => {
    expectTypeOf<ModulesClient['incoming']['error-result']>().toEqualTypeOf<{
      code: string;
      message: string;
    }>();
  });

  it('has module-task-data-result', () => {
    expectTypeOf<ModulesClient['incoming']['module-task-data-result']>().toEqualTypeOf<{
      result: string;
    }>();
  });
});

describe('ModulesClient — outgoing (server incoming)', () => {
  it('has insert-record', () => {
    expectTypeOf<ModulesClient['outgoing']['insert-record']>().toEqualTypeOf<{
      name: string;
      value: string;
    }>();
  });

  it('has get-all-records with empty payload', () => {
    expectTypeOf<ModulesClient['outgoing']['get-all-records']>().toEqualTypeOf<{}>();
  });

  it('has get-record', () => {
    expectTypeOf<ModulesClient['outgoing']['get-record']>().toEqualTypeOf<{ id: number }>();
  });

  it('has delete-record', () => {
    expectTypeOf<ModulesClient['outgoing']['delete-record']>().toEqualTypeOf<{ id: number }>();
  });
});

describe('ModulesClient — streams', () => {
  it('has stream-connection-id', () => {
    expectTypeOf<ModulesClient['streams']>().toHaveProperty('stream-connection-id');
  });

  it('stream-connection-id has correct payload and chunk', () => {
    expectTypeOf<ModulesClient['streams']['stream-connection-id']['payload']>().toEqualTypeOf<{
      count: number;
    }>();
    expectTypeOf<ModulesClient['streams']['stream-connection-id']['chunk']>().toEqualTypeOf<{
      id: string;
    }>();
  });

  it('stream-connection-id has no cursor or nudges', () => {
    expectTypeOf<ModulesClient['streams']['stream-connection-id']>().not.toHaveProperty('cursor');
    expectTypeOf<ModulesClient['streams']['stream-connection-id']>().not.toHaveProperty('nudges');
    expectTypeOf<ModulesClient['streams']['stream-connection-id']>().not.toHaveProperty(
      'broadcast',
    );
  });

  it('has stream-throw-on-cancel', () => {
    expectTypeOf<ModulesClient['streams']>().toHaveProperty('stream-throw-on-cancel');
  });

  it('stream-throw-on-cancel has correct chunk', () => {
    expectTypeOf<ModulesClient['streams']['stream-throw-on-cancel']['chunk']>().toEqualTypeOf<{
      tick: number;
    }>();
  });
});

describe('ModulesClient — stream resumable flags', () => {
  it('stream-connection-id is not resumable', () => {
    expectTypeOf<
      ModulesClient['streams']['stream-connection-id']['resumable']
    >().toEqualTypeOf<false>();
  });

  it('stream-throw-on-cancel is not resumable', () => {
    expectTypeOf<
      ModulesClient['streams']['stream-throw-on-cancel']['resumable']
    >().toEqualTypeOf<false>();
  });
});

describe('ModulesClient — empty slots', () => {
  it('channels is empty', () => {
    expectTypeOf<keyof ModulesClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof ModulesClient['namespaces']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof ModulesClient['requests']>().toBeNever();
  });
});

describe('ModulesClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ModulesClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ModulesClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ModulesClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ModulesClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ModulesClient['errors']>().toHaveProperty('internal-error');
  });
});
