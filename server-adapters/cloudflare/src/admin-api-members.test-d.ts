import { server } from '@livething/server';
import { plugin } from '@livething/server/plugins';
import { expectTypeOf } from 'vitest';
import { bind } from './index.ts';
import type { CloudflareAdmin } from './index.ts';

const huddleBase = server({
  authenticate: () => ({ userId: 'user_9', meta: { displayName: 'Ada' } }),
  capabilities: [],
});
const huddle = huddleBase.assemble({
  handlers: [],
  api: (ctx) => ({
    onlineCount(): number {
      return ctx.connectionCount;
    },
    retentionDays: 30,
  }),
});

class HuddleServer extends bind(huddle) {}

declare const stub: DurableObjectStub<HuddleServer>;

const admin = await stub.admin();

expectTypeOf(await admin.onlineCount()).toEqualTypeOf<number>();

// @ts-expect-error — buildAdmin() keeps only function members of `api`, so a value never reaches the stub
await admin.retentionDays;

expectTypeOf<CloudflareAdmin<typeof huddle>>().toHaveProperty('onlineCount');
expectTypeOf<CloudflareAdmin<typeof huddle>>().not.toHaveProperty('retentionDays');
// A definition with no plugins has no plugin().
expectTypeOf<CloudflareAdmin<typeof huddle>>().not.toHaveProperty('plugin');

// A listed plugin's api methods, by plugin id.
const pollsScope = server({ scope: 'plugin', capabilities: [] });
const Polls = plugin('acme:polls', {
  definition: pollsScope.assemble({
    handlers: [],
    api: () => ({
      results: (pollId: string) => ({ pollId, votes: 3 }),
      maxOptions: 10,
    }),
  }),
});
const withPolls = server({ capabilities: [Polls()] }).assemble({ handlers: [] });

class PollsServer extends bind(withPolls) {}

declare const pollsStub: DurableObjectStub<PollsServer>;

const pollsAdmin = await pollsStub.admin();
// Workers RPC adds `Disposable` to an object it returns.
const _results: { pollId: string; votes: number } = await pollsAdmin
  .plugin('acme:polls')
  .results('p_1');
const _pipelined: { pollId: string; votes: number } = await pollsStub
  .admin()
  .plugin('acme:polls')
  .results('p_1');
void [_results, _pipelined];
// @ts-expect-error — the api's argument types are kept
await pollsAdmin.plugin('acme:polls').results(1);
// @ts-expect-error — only methods reach the stub
await pollsAdmin.plugin('acme:polls').maxOptions;
// @ts-expect-error — no plugin with that id is listed
pollsAdmin.plugin('acme:nope');

// Built-in names win at runtime, so the type shows the built-in, not the app's own method.
const shadowing = server({ capabilities: [Polls()] }).assemble({
  handlers: [],
  api: () => ({
    plugin: () => 'mine',
    purgeUser: (): string => 'mine',
    archive: (): number => 1,
  }),
});
expectTypeOf<ReturnType<CloudflareAdmin<typeof shadowing>['archive']>>().toEqualTypeOf<number>();
expectTypeOf<ReturnType<CloudflareAdmin<typeof shadowing>['purgeUser']>>().toEqualTypeOf<
  Promise<void>
>();
expectTypeOf<
  Parameters<CloudflareAdmin<typeof shadowing>['plugin']>[0]
>().toEqualTypeOf<'acme:polls'>();
