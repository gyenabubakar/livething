import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { tags } from '~/tags/capability.ts';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function buildEngine(handler: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const server = adapter({
    id: 'tags-service-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),

        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  server(handler, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

describe('tags() runtime install', () => {
  it('creates the tag table and its indexes at boot', async () => {
    const base = define({
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    const handler = base.assemble({ handlers: [] });
    const engine = buildEngine(handler);

    await engine.initialize();

    const created = engine.core.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
      .toArray()
      .map((row) => row.name);
    expect(created).toContain('__wskit_tags');
    expect(created).toContain('__wskit_idx_tags_user');
    expect(created).toContain('__wskit_idx_tags_group_key');
  });

  it('registers a purgeUser hook', async () => {
    const base = define({
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    const handler = base.assemble({ handlers: [] });
    const engine = buildEngine(handler);

    await engine.initialize();

    expect(engine.core.hooks.purgeUser).toHaveLength(1);
  });
});
