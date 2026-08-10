import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { purgeUser } from '~/_engine/runtime/purge-user.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { inbox } from './capability.ts';
import { insertInboxRows, loadUndeliveredRows } from './storage.ts';

function buildEngine(handler: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const server = adapter({
    id: 'inbox-service-spec',
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

function buildInboxEngine(): Engine {
  const base = define({
    env: t<Record<string, never>>(),
    capabilities: [channels(), sequence({ persist: true }), dedup()],
  });
  const chat = base.channel('chat', { capabilities: [inbox()] });
  const handler = base.assemble({ handlers: [chat] });
  return buildEngine(handler);
}

function buildChannelsOnlyEngine(): Engine {
  const base = define({
    env: t<Record<string, never>>(),
    capabilities: [channels(), sequence({ persist: true }), dedup()],
  });
  const chat = base.channel('chat', {});
  const handler = base.assemble({ handlers: [chat] });
  return buildEngine(handler);
}

describe('inbox runtime install', () => {
  it('registers a purgeUser hook, on top of the one channels() already registers', async () => {
    const withoutInbox = buildChannelsOnlyEngine();
    await withoutInbox.initialize();
    const baseline = withoutInbox.core.hooks.purgeUser.length;

    const withInbox = buildInboxEngine();
    await withInbox.initialize();

    expect(withInbox.core.hooks.purgeUser).toHaveLength(baseline + 1);
  });

  it("purging a user deletes their inbox rows, leaving another user's rows intact", async () => {
    const engine = buildInboxEngine();
    await engine.initialize();

    const core = engine.core;
    insertInboxRows(core.storage.sql, {
      userIds: ['alice', 'bob'],
      channelName: 'chat',
      channelFamily: null,
      frame: { event: 'room-msg', payload: { text: 'hi' }, seq: 1, messageId: 'm1' },
      now: 1000,
    });

    await purgeUser(core, 'alice');

    expect(loadUndeliveredRows(core.storage.sql, 'alice')).toEqual([]);
    expect(loadUndeliveredRows(core.storage.sql, 'bob')).toHaveLength(1);
  });
});
