import { describe, expectTypeOf, it } from 'vitest';
import type { Ctx } from '@wskit/server';
import type { PluginsClient, pluginsContract } from './handler.ts';

describe('PluginsClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<PluginsClient['incoming']>().not.toBeAny();
    expectTypeOf<PluginsClient['outgoing']>().not.toBeAny();
    expectTypeOf<PluginsClient['requests']>().not.toBeAny();
    expectTypeOf<PluginsClient['streams']>().not.toBeAny();
    expectTypeOf<PluginsClient['channels']>().not.toBeAny();
    expectTypeOf<PluginsClient['namespaces']>().not.toBeAny();
    expectTypeOf<PluginsClient['errors']>().not.toBeAny();
  });
});

describe('PluginsClient — incoming (server outgoing)', () => {
  it('has record-inserted', () => {
    expectTypeOf<PluginsClient['incoming']['record-inserted']>().toEqualTypeOf<{ id: number }>();
  });

  it('has record-count', () => {
    expectTypeOf<PluginsClient['incoming']['record-count']>().toEqualTypeOf<{ count: number }>();
  });

  it('has message-count', () => {
    expectTypeOf<PluginsClient['incoming']['message-count']>().toEqualTypeOf<{ count: number }>();
  });

  it('has generated-id', () => {
    expectTypeOf<PluginsClient['incoming']['generated-id']>().toEqualTypeOf<{
      value: string | null;
    }>();
  });

  it('has plugin-rewrite-result', () => {
    expectTypeOf<PluginsClient['incoming']['plugin-rewrite-result']>().toEqualTypeOf<{
      text: string;
      rewritten?: boolean | undefined;
    }>();
  });

  it('has plugin-every-tick', () => {
    expectTypeOf<PluginsClient['incoming']['plugin-every-tick']>().toEqualTypeOf<{
      count: number;
    }>();
  });

  it('has plugin-flaky-result', () => {
    expectTypeOf<PluginsClient['incoming']['plugin-flaky-result']>().toEqualTypeOf<{
      attempts: number;
    }>();
  });

  it('has plugin-dlq-result', () => {
    expectTypeOf<PluginsClient['incoming']['plugin-dlq-result']>().toEqualTypeOf<{
      taskId: string;
      attempts: number;
      error: string;
    }>();
  });

  it('has error-result', () => {
    expectTypeOf<PluginsClient['incoming']['error-result']>().toEqualTypeOf<{
      code: string;
      message: string;
    }>();
  });

  it('has plugin-task-data-result', () => {
    expectTypeOf<PluginsClient['incoming']['plugin-task-data-result']>().toEqualTypeOf<{
      result: string;
    }>();
  });
});

describe('PluginsClient — outgoing (server incoming)', () => {
  it('has insert-record', () => {
    expectTypeOf<PluginsClient['outgoing']['insert-record']>().toEqualTypeOf<{
      name: string;
      value: string;
    }>();
  });

  it('has get-all-records with empty payload', () => {
    expectTypeOf<PluginsClient['outgoing']['get-all-records']>().toEqualTypeOf<{}>();
  });

  it('has get-record', () => {
    expectTypeOf<PluginsClient['outgoing']['get-record']>().toEqualTypeOf<{ id: number }>();
  });

  it('has delete-record', () => {
    expectTypeOf<PluginsClient['outgoing']['delete-record']>().toEqualTypeOf<{ id: number }>();
  });
});

describe('PluginsClient — streams', () => {
  it('has stream-connection-id', () => {
    expectTypeOf<PluginsClient['streams']>().toHaveProperty('stream-connection-id');
  });

  it('stream-connection-id has correct payload and chunk', () => {
    expectTypeOf<PluginsClient['streams']['stream-connection-id']['payload']>().toEqualTypeOf<{
      count: number;
    }>();
    expectTypeOf<PluginsClient['streams']['stream-connection-id']['chunk']>().toEqualTypeOf<{
      id: string;
    }>();
  });

  it('stream-connection-id has no cursor or nudges', () => {
    expectTypeOf<PluginsClient['streams']['stream-connection-id']>().not.toHaveProperty('cursor');
    expectTypeOf<PluginsClient['streams']['stream-connection-id']>().not.toHaveProperty('nudges');
    expectTypeOf<PluginsClient['streams']['stream-connection-id']>().not.toHaveProperty(
      'broadcast',
    );
  });

  it('has stream-throw-on-cancel', () => {
    expectTypeOf<PluginsClient['streams']>().toHaveProperty('stream-throw-on-cancel');
  });

  it('stream-throw-on-cancel has correct chunk', () => {
    expectTypeOf<PluginsClient['streams']['stream-throw-on-cancel']['chunk']>().toEqualTypeOf<{
      tick: number;
    }>();
  });
});

describe('PluginsClient — stream resumable flags', () => {
  it('stream-connection-id is not resumable', () => {
    expectTypeOf<
      PluginsClient['streams']['stream-connection-id']['resumable']
    >().toEqualTypeOf<false>();
  });

  it('stream-throw-on-cancel is not resumable', () => {
    expectTypeOf<
      PluginsClient['streams']['stream-throw-on-cancel']['resumable']
    >().toEqualTypeOf<false>();
  });
});

describe('PluginsClient — empty slots', () => {
  it('channels is empty', () => {
    expectTypeOf<keyof PluginsClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof PluginsClient['namespaces']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof PluginsClient['requests']>().toBeNever();
  });
});

describe('PluginsClient — plugin-prefixed surface (Drizzle plugin)', () => {
  it('plugin outgoing event lands on the client under the literal prefixed key with its inferred payload', () => {
    expectTypeOf<PluginsClient['incoming']['__e2e:drizzle:drizzle-ready']>().toEqualTypeOf<{
      tables: string[];
    }>();
  });

  it('plugin error code lands on the client under its literal code', () => {
    expectTypeOf<PluginsClient['errors']['e2e-drizzle/denied']>().not.toBeAny();
  });

  it('server-side ctx.schedule accepts the literal plugin task ids and rejects typos', () => {
    type Handler = Ctx<typeof pluginsContract>;
    type ScheduleArg = Parameters<Handler['schedule']>[0];

    // Every declared plugin task id is a valid argument.
    expectTypeOf<
      '__e2e:drizzle:drizzle-vacuum' extends ScheduleArg ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      '__e2e:drizzle:drizzle-every-tick' extends ScheduleArg ? true : false
    >().toEqualTypeOf<true>();

    // A typo in the suffix is rejected — full literal narrowing.
    expectTypeOf<
      '__e2e:drizzle:drizzle-vacuumX' extends ScheduleArg ? true : false
    >().toEqualTypeOf<false>();

    // A typo in the prefix is also rejected — plugin id is locked to the
    // literal, not widened to `${string}`.
    expectTypeOf<
      '__NOT-the-drizzle-plugin:drizzle-vacuum' extends ScheduleArg ? true : false
    >().toEqualTypeOf<false>();
  });
});

describe('PluginsClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<PluginsClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<PluginsClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<PluginsClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<PluginsClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<PluginsClient['errors']>().toHaveProperty('internal-error');
  });
});
