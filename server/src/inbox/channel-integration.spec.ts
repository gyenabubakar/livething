import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { persistMembership } from '~/channel/membership.ts';
import { dedup } from '~/dedup/capability.ts';
import { loadUndeliveredRows } from '~/inbox/storage.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { inbox } from './capability.ts';

function buildEngine(handler: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const server = adapter({
    id: 'inbox-channel-integration-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        env: {},
        platform: {},
        timers: createTestTimers(),
        waitUntil: () => {},
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  server(handler, undefined as never);
  if (!captured) throw new Error('engine not captured');
  return captured;
}

describe('inbox() on a channel — writes real per-member rows on broadcast', () => {
  it('writes an undelivered row for a member of a channel that lists inbox() in its own capabilities', async () => {
    const base = define({
      env: t<Record<string, never>>(),
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const chat = base.channel('chat', { capabilities: [inbox()] });
    const plain = base.channel('plain', {});
    const handler = base.assemble({ handlers: [chat, plain] });
    const engine = buildEngine(handler);
    await engine.initialize();

    const core = engine.core;
    persistMembership(core, { userId: 'alice', channelName: 'chat', channelFamily: null });
    persistMembership(core, { userId: 'alice', channelName: 'plain', channelFamily: null });

    core.inboxService!.fanOut(core, {
      channelName: 'chat',
      channelFamily: null,
      event: 'room-msg',
      payload: { text: 'hi' },
      seq: 1,
      messageId: 'm1',
    });

    const rows = loadUndeliveredRows(core.storage.sql, 'alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelName: 'chat', event: 'room-msg', seq: 1 });
  });

  it('writes no row for the same member on a channel that does not list inbox()', async () => {
    const base = define({
      env: t<Record<string, never>>(),
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const chat = base.channel('chat', { capabilities: [inbox()] });
    const plain = base.channel('plain', {});
    const handler = base.assemble({ handlers: [chat, plain] });
    const engine = buildEngine(handler);
    await engine.initialize();

    const core = engine.core;
    persistMembership(core, { userId: 'alice', channelName: 'plain', channelFamily: null });

    core.inboxService!.fanOut(core, {
      channelName: 'plain',
      channelFamily: null,
      event: 'room-msg',
      payload: { text: 'hi' },
      seq: 1,
      messageId: 'm1',
    });

    expect(loadUndeliveredRows(core.storage.sql, 'alice')).toHaveLength(0);
  });
});

describe('a host missing sequence()/dedup() fails the build, naming what to add and where', () => {
  it('fails when a channel lists inbox() but the host is missing sequence() and dedup()', () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [channels()] });
    const chat = base.channel('chat', { capabilities: [inbox()] });
    expect(() => base.assemble({ handlers: [chat] })).toThrow(
      "[wskit] The sequence() capability is required by inbox but is not listed. Add sequence() to this channel's capabilities, or to define({ capabilities: [...] }).",
    );
  });

  it('fails when a channel lists inbox() but the host — a plain app, no plugin involved — is missing channels()', () => {
    // base.channel() itself gates on channels() being listed before a channel
    // can even be built, so this throws earlier than resolveCapabilityRequirements
    // — but it proves the same thing: a non-plugin app still needs channels()
    // listed, with no plugin around to have satisfied the requirement for it.
    const base = define({
      env: t<Record<string, never>>(),
      capabilities: [sequence({ persist: true }), dedup()],
    });
    const escapeHatch = base as unknown as { channel(name: string, config?: unknown): unknown };
    expect(() => escapeHatch.channel('chat', { capabilities: [inbox()] })).toThrow(
      '[wskit] base.channel() needs the channels() capability. Add channels() to capabilities.',
    );
  });
});
