/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixtures for the plugin authoring surface and how a plugin's
 * contract lands on the host's `InferClient`.
 *
 * Covers: the plugin `api` ctx is the scoped ctx (gap 1); `api` return type is
 * inferred without an annotation, surfaced on the server ctx via `ctx.plugin(id)`
 * (gap 2); a plugin's events fold into the host's TOP-LEVEL client maps under
 * their `__<id>::` wire-prefixed names — to the client a plugin event is just an
 * event with a prefixed name (gap 3); and a plugin channel lands in the
 * top-level `channels` map under its prefixed family name, flipped into the
 * client view, with its inner events unprefixed (gap 4).
 */
import { t } from '~/_api/definitions.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox, readReceipts } from '~/inbox/capability.ts';
import { rateLimit } from '~/rate-limit/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import type { InferPluginClient } from '~/_define/plugins.ts';
import type { ScopedServerConfig, ServerConfig } from '~/_define/server.ts';
import type { InferClient } from '~/infer-client.ts';

// ---------------------------------------------------------------------------
// Gap 1 — a scoped plugin's `api` ctx is the plugin's scoped connectionless ctx, not `any`.
// ---------------------------------------------------------------------------
const scopedBase = server({
  scope: 'plugin',
  capabilities: [emits({ 'p-online': t<{ id: string }>() }), scheduled({ 'p-task': null })],
});

const scopedDefinition = scopedBase.on('beat', {
  input: v.object({}),
  run(ctx) {
    ctx.send('p-online', { id: ctx.connection.id });
  },
});

const scopedTask = scopedBase.scheduled('p-task', { run() {} });

const ApiPlugin = plugin('acme:presence', {
  definition: scopedBase.assemble({
    handlers: [scopedDefinition, scopedTask],
    api: (ctx) => {
      // The declared emit with the right payload is allowed.
      ctx.broadcast('p-online', { id: 'conn_1' });

      // @ts-expect-error — wrong payload shape for a declared emit
      ctx.broadcast('p-online', { id: 123 });

      // @ts-expect-error — the api is connectionless: no caller connection
      void ctx.connection;

      // @ts-expect-error — the api is connectionless: no `send` to a caller
      void ctx.send;

      // @ts-expect-error — undeclared method does not exist on the scoped ctx
      ctx.nope();

      // The `scheduled()` capability arm is present because it was listed.
      ctx.schedule('p-task', { time: 0 });

      return { ok: true };
    },
  }),
});
void ApiPlugin;

// ---------------------------------------------------------------------------
// Gap 2 — `api` return type is inferred (no annotation) and reaches the host
// through the SERVER ctx as `ctx.plugin(id)`. The api type lives on the server
// ctx / contract slot, not on the client `InferClient`.
// ---------------------------------------------------------------------------
const inferBase = server({ scope: 'plugin', capabilities: [emits({ e: t<{ n: number }>() })] });
const inferDefinition = inferBase.on('x', {
  run(ctx) {
    ctx.send('e', { n: 1 });
  },
});
const InferApiPlugin = plugin('acme:infer', {
  definition: inferBase.assemble({
    handlers: [inferDefinition],
    api: (ctx) => {
      void ctx;
      return { foo: 1, bar: () => 'x' };
    },
  }),
});

const inferHost = server({
  capabilities: [InferApiPlugin(), scheduled({ 'nightly-report': null })],
});

// Connectionless code reaches the plugin too: a scheduled task body and the host's own `api`.
export const nightlyReport = inferHost.scheduled('nightly-report', {
  run(ctx) {
    expectTypeOf(ctx.plugin('acme:infer').foo).toEqualTypeOf<number>();
  },
});

export const inferHostDefinition = inferHost.assemble({
  handlers: [nightlyReport],
  api: (ctx) => {
    // @ts-expect-error — only the IDs of listed plugins are accepted
    ctx.plugin('acme:nope');
    // @ts-expect-error — not even with an explicit type argument
    ctx.plugin<{ foo: number }>('acme:nope');

    return { foo: () => ctx.plugin('acme:infer').foo };
  },
});

// A host with no plugins has no `plugin` on its connectionless ctx.
export const noPlugins = server({ capabilities: [scheduled({ cleanup: null })] });
export const cleanup = noPlugins.scheduled('cleanup', {
  run(ctx) {
    // @ts-expect-error — no plugin is listed
    void ctx.plugin;
  },
});
inferHost.on('host-probe', {
  run(ctx) {
    const api = ctx.plugin('acme:infer');
    // @ts-expect-error — only the IDs of listed plugins are accepted
    ctx.plugin('acme:infer-typo');
    // Not `any` — a regression to `any` would make `not.toBeAny` fail.
    expectTypeOf(api).not.toBeAny();
    expectTypeOf(api.foo).toEqualTypeOf<number>();
    // Bidirectional assignment pins `bar` to exactly `() => string`.
    const _apiForward: { foo: number; bar: () => string } = api;
    const _apiBack: typeof api = { foo: 1, bar: () => 'x' };
    void [_apiForward, _apiBack];
  },
});

// ---------------------------------------------------------------------------
// Gap 3 — a plain plugin's events fold into the host's TOP-LEVEL client maps
// under their `__<id>::` wire-prefixed names, flipped into the client view. The
// client carries no `plugins` key; short names never appear; a made-up prefixed
// name is rejected. (No channel here — this gap isolates top-level name
// discrimination; a plugin channel is covered by gap 4 below.)
// ---------------------------------------------------------------------------
const leakScoped = server({
  scope: 'plugin',
  capabilities: [emits({ 'pl-out': t<{ a: number }>() })],
});

const leakOn = leakScoped.on('pl-in', { input: v.object({ a: v.number() }), run() {} });
const leakReq = leakScoped.on('pl-also-in', { run() {} });

const LeakPlugin = plugin('acme:leak', {
  definition: leakScoped.assemble({
    handlers: [leakOn, leakReq],
    api: (ctx) => {
      void ctx;
      return {};
    },
  }),
});

const leakHost = server({
  capabilities: [emits({ 'host-out': t<{ h: number }>() }), LeakPlugin()],
});
const leakHostOn = leakHost.on('host-in', { input: v.object({ h: v.number() }), run() {} });
const leakHostDef = leakHost.assemble({ handlers: [leakHostOn] });
type LeakClient = InferClient<typeof leakHostDef>;

// The host's own names are present at the top level (discrimination guard so the
// checks below are not vacuously satisfied by an empty/any map).
expectTypeOf<LeakClient['incoming']>().toHaveProperty('host-out');
expectTypeOf<LeakClient['outgoing']>().toHaveProperty('host-in');

// Short (un-prefixed) plugin names never appear anywhere on the client.
expectTypeOf<LeakClient['incoming']>().not.toHaveProperty('pl-out');
expectTypeOf<LeakClient['outgoing']>().not.toHaveProperty('pl-in');
expectTypeOf<LeakClient['outgoing']>().not.toHaveProperty('pl-also-in');

// The plugin's events ARE present at the TOP LEVEL under their `__<id>::` wire
// names, flipped into the client's perspective — to the client, just an event
// with a prefixed name.
expectTypeOf<LeakClient['incoming']>().toHaveProperty('__acme:leak::pl-out'); // server emit -> client incoming
expectTypeOf<LeakClient['incoming']['__acme:leak::pl-out']>().toEqualTypeOf<{ a: number }>();
expectTypeOf<LeakClient['outgoing']>().toHaveProperty('__acme:leak::pl-in'); // server on -> client outgoing
expectTypeOf<LeakClient['outgoing']>().toHaveProperty('__acme:leak::pl-also-in');

// A made-up prefixed name is still rejected (discrimination guard) — the keys
// are concrete literals, not a `__id::${string}` index signature.
expectTypeOf<LeakClient['incoming']>().not.toHaveProperty('__acme:leak::nope');

// The client does not carry a `plugins` key — plugin events live in the
// normal maps, not a separate grouping.
expectTypeOf<LeakClient>().not.toHaveProperty('plugins');

// ---------------------------------------------------------------------------
// Gap 4 — a plugin channel folds into the top-level `channels` map under its
// prefixed `__<id>::family` name, flipped into the client view. The channel's
// inner events stay scoped to it and are NOT prefixed.
// ---------------------------------------------------------------------------
const chScoped = server({ scope: 'plugin', capabilities: [channels(), serverRequests()] });
const chFam = chScoped.channel(['fam', 'fam:{id}'], {
  subscribe: v.object({ token: v.string() }),
  capabilities: [
    emits({ 'fam-tick': t<{ n: number }>() }),
    serverRequests({
      'fam-confirm': { out: t<{ q: string }>(), in: v.object({ ok: v.boolean() }) },
    }),
  ],
});
const chFamDefinition = chFam.on('fam-ping', { input: v.object({ p: v.boolean() }), run() {} });
const ChPlugin = plugin('acme:chan', {
  definition: chScoped.assemble({ handlers: [chFamDefinition], api: () => ({}) }),
});

const chHost = server({ capabilities: [ChPlugin()] });
const chHostDef = chHost.assemble({ handlers: [chHost.on('host-noop', { run() {} })] });
type ChClient = InferClient<typeof chHostDef>;

// The short family name never appears; the prefixed one is the address.
expectTypeOf<ChClient['channels']>().not.toHaveProperty('fam');
expectTypeOf<ChClient['channels']>().toHaveProperty('__acme:chan::fam');

type ChFamScope = ChClient['channels']['__acme:chan::fam'];
// Server `outgoing` emit becomes the client's `incoming` for the channel.
expectTypeOf<ChFamScope['incoming']>().toHaveProperty('fam-tick');
// Server channel `on` becomes the client's `outgoing`.
expectTypeOf<ChFamScope['outgoing']>().toHaveProperty('fam-ping');
// Addressing discriminator + subscribe payload survive the flip.
expectTypeOf<ChFamScope['addressing']>().toEqualTypeOf<'dynamic'>();
expectTypeOf<ChFamScope['subscribePayload']>().toEqualTypeOf<{ token: string }>();
expectTypeOf<ChFamScope['serverRequests']>().toHaveProperty('fam-confirm');
expectTypeOf<ChFamScope['serverRequests']['fam-confirm']['payload']>().toEqualTypeOf<{
  q: string;
}>();
expectTypeOf<ChFamScope['serverRequests']['fam-confirm']['response']>().toEqualTypeOf<{
  ok: boolean;
}>();

// ---------------------------------------------------------------------------
// InferPluginClient — a plugin author derives the client-side contract from the
// server plugin, in the client's perspective with PLAIN (un-prefixed) names.
// ---------------------------------------------------------------------------
type LeakWire = InferPluginClient<typeof LeakPlugin>;
// server emit -> client incoming; server on -> client outgoing; plain names.
expectTypeOf<LeakWire['incoming']>().toEqualTypeOf<{ 'pl-out': { a: number } }>();
expectTypeOf<LeakWire['outgoing']>().toHaveProperty('pl-in');
expectTypeOf<LeakWire['outgoing']>().toHaveProperty('pl-also-in');
// Never prefixed, and never leaks the server-perspective direction.
expectTypeOf<LeakWire['incoming']>().not.toHaveProperty('__acme:leak::pl-out');
expectTypeOf<LeakWire['incoming']>().not.toHaveProperty('pl-in');

// Accepts the capability the factory returns, too, not only the factory.
type LeakWireFromCap = InferPluginClient<ReturnType<typeof LeakPlugin>>;
expectTypeOf<LeakWireFromCap['incoming']>().toEqualTypeOf<{ 'pl-out': { a: number } }>();

// A plugin channel comes through under its plain family name, flipped to the
// client view, its inner events unprefixed — exactly a client channel contract.
type ChWire = InferPluginClient<typeof ChPlugin>;
expectTypeOf<ChWire['channels']>().toHaveProperty('fam');
expectTypeOf<ChWire['channels']>().not.toHaveProperty('__acme:chan::fam');
expectTypeOf<ChWire['channels']['fam']['incoming']>().toHaveProperty('fam-tick');
expectTypeOf<ChWire['channels']['fam']['outgoing']>().toHaveProperty('fam-ping');

// ---------------------------------------------------------------------------
// dependsOn — host-owned engine factories only. A behavior capability the
// plugin can own itself (requests, channels, …) and a plugin factory are both
// compile errors: a plugin lists behavior in its own capabilities, and only the
// host's engines (which carry __hostOnly) are valid dependsOn targets.
// ---------------------------------------------------------------------------
const depScoped = server({ scope: 'plugin' });
const DepPlugin = plugin('acme:dep', {
  definition: depScoped.assemble({ handlers: [depScoped.on('noop', { run() {} })] }),
});

const depHost = server({ scope: 'plugin' });
// A host-owned engine factory is accepted.
plugin('acme:ok', {
  definition: depHost.assemble({ handlers: [depHost.on('noop', { run() {} })] }),
  dependsOn: [rateLimit],
});
plugin('acme:behavior', {
  definition: depHost.assemble({ handlers: [depHost.on('noop', { run() {} })] }),
  // @ts-expect-error — behavior capabilities a plugin owns itself are not dependsOn targets.
  dependsOn: [clientRequests],
});
plugin('acme:bad', {
  definition: depHost.assemble({ handlers: [depHost.on('noop', { run() {} })] }),
  // @ts-expect-error — a plugin factory is not a valid dependsOn target.
  dependsOn: [DepPlugin],
});

// ---------------------------------------------------------------------------
// `scope` selects the builder. Today `'plugin'` is the only scoped form, and an
// app never sets it — both are compile-time gates, not runtime checks.
//
// These assert against the config types directly rather than through `server`.
// A failed `server(...)` call reports one error for the whole call, so it can
// go red for a reason other than the field under test; a `satisfies` clause
// pins each error to its own property. An unnecessary directive is itself an
// error (TS2578), so none of these can pass vacuously.
// ---------------------------------------------------------------------------

({
  // @ts-expect-error — a top-level config never carries a scope.
  scope: 'plugin',
}) satisfies ServerConfig<Record<string, never>>;

({
  // @ts-expect-error — `ServerConfig` has no `scoped` property; the field is `scope`.
  scoped: true,
}) satisfies ServerConfig<Record<string, never>>;

({ scope: 'plugin' }) satisfies ScopedServerConfig;

({
  // @ts-expect-error — 'channel' is not a scope the builder knows.
  scope: 'channel',
}) satisfies ScopedServerConfig;

// And end to end, so the overload itself is covered: a typo'd flag on a real
// call is rejected, with TypeScript pointing at the correct field.
// @ts-expect-error — `ServerConfig` has no `scoped` property; the field is `scope`.
server({ scoped: true });

// ---------------------------------------------------------------------------
// `inbox()` / `readReceipts()` are channel-only capabilities — the
// `__channelOnly` brand rejects them from the host's and a plugin's top-level
// `capabilities`. The gate lives on `server(...)`'s own generic constraint,
// not on `ServerConfig`/`ScopedServerConfig` themselves (their `TCaps` bound
// is the wider `AnyCapability`), so — unlike the `satisfies` checks above —
// this one only fires through a real call, the same way the `scope` overload
// check just above does.
// ---------------------------------------------------------------------------
server({
  // @ts-expect-error — inbox() is channel-only; list it in a channel's own `capabilities`.
  capabilities: [inbox()],
});

server({
  scope: 'plugin',
  // @ts-expect-error — inbox() is channel-only; list it in a channel's own `capabilities`.
  capabilities: [inbox()],
});

server({
  // @ts-expect-error — readReceipts() is channel-only; list it in a channel's own `capabilities`.
  capabilities: [readReceipts()],
});

server({
  scope: 'plugin',
  // @ts-expect-error — readReceipts() is channel-only; list it in a channel's own `capabilities`.
  capabilities: [readReceipts()],
});
