import { describe, expectTypeOf, it } from 'vitest';
import type { PluginsClient } from './handler.ts';

describe('PluginsClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<PluginsClient['incoming']>().not.toBeAny();
    expectTypeOf<PluginsClient['outgoing']>().not.toBeAny();
    expectTypeOf<PluginsClient['clientRequests']>().not.toBeAny();
    expectTypeOf<PluginsClient['streams']>().not.toBeAny();
    expectTypeOf<PluginsClient['channels']>().not.toBeAny();

    expectTypeOf<PluginsClient['errors']>().not.toBeAny();
  });

  it('the client carries no plugins key', () => {
    expectTypeOf<PluginsClient>().not.toHaveProperty('plugins');
  });
});

describe('PluginsClient — host incoming (server outgoing)', () => {
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
});

describe('PluginsClient — host outgoing (server incoming)', () => {
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

describe('PluginsClient — host streams', () => {
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

  it('stream-connection-id has no nudges', () => {
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

describe('PluginsClient — stream kind', () => {
  it('stream-connection-id is ephemeral', () => {
    expectTypeOf<
      PluginsClient['streams']['stream-connection-id']['kind']
    >().toEqualTypeOf<'ephemeral'>();
  });

  it('stream-throw-on-cancel is ephemeral', () => {
    expectTypeOf<
      PluginsClient['streams']['stream-throw-on-cancel']['kind']
    >().toEqualTypeOf<'ephemeral'>();
  });
});

describe('PluginsClient — Feed plugin (prefixed __id:: names, top-level)', () => {
  it('exposes the plugin channel and its event under prefixed names', () => {
    expectTypeOf<
      PluginsClient['channels']['__e2e:feed::room']['incoming']['joined']
    >().toEqualTypeOf<{ who: string }>();
  });
  it('exposes the plugin request under its prefixed name', () => {
    expectTypeOf<PluginsClient['clientRequests']['__e2e:feed::echo']>().toEqualTypeOf<{
      payload: { text: string };
      response: { echoed: string };
    }>();
  });
  it('exposes the plugin emit under its prefixed name', () => {
    expectTypeOf<PluginsClient['incoming']['__e2e:feed::welcome']>().toEqualTypeOf<{
      name: string;
    }>();
  });
  it('exposes both plugin stream kinds under prefixed names', () => {
    // Both durable kinds surface as 'persistent' on the client; plain is 'ephemeral'.
    expectTypeOf<
      PluginsClient['streams']['__e2e:feed::feed']['kind']
    >().toEqualTypeOf<'persistent'>();
    expectTypeOf<PluginsClient['streams']['__e2e:feed::feed']['chunk']>().toEqualTypeOf<{
      row: number;
    }>();
    expectTypeOf<
      PluginsClient['streams']['__e2e:feed::feed-plain']['kind']
    >().toEqualTypeOf<'ephemeral'>();
    expectTypeOf<
      PluginsClient['streams']['__e2e:feed::feed-recorded']['kind']
    >().toEqualTypeOf<'persistent'>();
  });

  it('exposes a plugin stream nudge under a plain nested key, not a prefixed one', () => {
    // The stream KEY is namespaced (`__e2e:feed::nudgeable`), but its nested nudge
    // key stays plain — nudges live inside the stream, not as top-level wire events.
    // The `__id::` prefix is added on the wire at send time (the scoped socket), so
    // the contract keeps the plain name the plugin author declared and calls.
    expectTypeOf<
      PluginsClient['streams']['__e2e:feed::nudgeable']['nudges']['boost']
    >().toEqualTypeOf<{ amount: number }>();
    expectTypeOf<PluginsClient['streams']['__e2e:feed::nudgeable']['nudges']>().not.toHaveProperty(
      '__e2e:feed::boost',
    );
  });
});

describe('PluginsClient — Drizzle plugin (prefixed __id:: names, top-level)', () => {
  it('plugin emit lands on the top-level incoming under its prefixed name', () => {
    expectTypeOf<PluginsClient['incoming']['__e2e:drizzle::drizzle-ready']>().toEqualTypeOf<{
      tables: string[];
    }>();
  });

  it('plugin scheduled-broadcast emits are on the top-level incoming, prefixed', () => {
    expectTypeOf<PluginsClient['incoming']['__e2e:drizzle::plugin-every-tick']>().toEqualTypeOf<{
      count: number;
    }>();
    expectTypeOf<PluginsClient['incoming']['__e2e:drizzle::plugin-flaky-result']>().toEqualTypeOf<{
      attempts: number;
    }>();
    expectTypeOf<PluginsClient['incoming']['__e2e:drizzle::plugin-dlq-result']>().toEqualTypeOf<{
      taskId: string;
      attempts: number;
      error: string;
    }>();
    expectTypeOf<
      PluginsClient['incoming']['__e2e:drizzle::plugin-task-data-result']
    >().toEqualTypeOf<{
      result: string;
    }>();
    expectTypeOf<PluginsClient['incoming']['__e2e:drizzle::error-result']>().toEqualTypeOf<{
      code: string;
      message: string;
    }>();
  });

  it('plugin trigger handlers are on the top-level outgoing, prefixed (client sends)', () => {
    expectTypeOf<PluginsClient['outgoing']>().toHaveProperty(
      '__e2e:drizzle::trigger-plugin-denied',
    );
    expectTypeOf<PluginsClient['outgoing']>().toHaveProperty('__e2e:drizzle::trigger-vacuum');
    expectTypeOf<PluginsClient['outgoing']>().toHaveProperty(
      '__e2e:drizzle::trigger-plugin-task-with-data',
    );
  });

  it('plugin error code lands on the top-level errors under its prefixed code', () => {
    expectTypeOf<PluginsClient['errors']['__e2e:drizzle::denied']>().not.toBeAny();
    expectTypeOf<PluginsClient['errors']['__e2e:drizzle::denied']>().toEqualTypeOf<{
      reason: string;
      op: string;
    }>();
  });

  it('short (un-prefixed) plugin names never appear on the client', () => {
    expectTypeOf<PluginsClient['incoming']>().not.toHaveProperty('drizzle-ready');
    expectTypeOf<PluginsClient['outgoing']>().not.toHaveProperty('trigger-vacuum');
    expectTypeOf<PluginsClient['errors']>().not.toHaveProperty('denied');
  });
});

describe('PluginsClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<PluginsClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<PluginsClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<PluginsClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<PluginsClient['errors']>().toHaveProperty('internal-error');
  });
});
