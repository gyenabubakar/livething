/* oxlint-disable no-unused-vars */
/** Compile-time checks for hooks written in `server({ ... })`, on an app and on a plugin. */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { context } from '~/ambient-context.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';

const capabilities = [emits({ notification: t<{ title: string }>() })] as const;

export const app = server({
  authenticate: (request) => ({ userId: request.url, meta: { name: 'Ama' } }),
  capabilities,
  onInit(ctx) {
    // @ts-expect-error: onInit has no connection, so no ctx.send
    ctx.send('notification', { title: 'x' });
  },
  onConnect(ctx) {
    ctx.send('notification', { title: ctx.meta.name });
    // @ts-expect-error: not a declared event
    ctx.send('nope', { title: 'x' });
    // @ts-expect-error: wrong payload
    ctx.send('notification', { title: 1 });
    // @ts-expect-error: not a meta field
    void ctx.meta.nope;
  },
  onDisconnect(ctx) {
    ctx.send('notification', { title: ctx.meta.name });
  },
  onPing(ctx) {
    ctx.send('notification', { title: ctx.meta.name });
  },
  onPong(ctx) {
    ctx.send('notification', { title: ctx.meta.name });
  },
  onError(ctx, error, event) {
    ctx.send('notification', { title: String(error) + String(event) });
  },
  onShutdown(ctx) {
    ctx.broadcast('notification', { title: 'bye' });
    // @ts-expect-error: onShutdown has no connection, so no ctx.send
    ctx.send('notification', { title: 'x' });
  },
  intercept(ctx, frame) {
    ctx.send('notification', { title: frame.event });
  },
  onOutgoing(ctx, frame) {
    ctx?.send('notification', { title: frame.event });
  },
});

export const plugin = server({
  scope: 'plugin',
  authenticate: () => ({ meta: { plan: 'free' } }),
  capabilities: [emits({ notification: t<{ title: string }>() })],
  onConnect(ctx) {
    ctx.send('notification', { title: ctx.meta.plan });
    // @ts-expect-error: not a declared event
    ctx.send('nope', { title: 'x' });
    // @ts-expect-error: wrong payload
    ctx.send('notification', { title: 1 });
    // @ts-expect-error: not a meta field
    void ctx.meta.nope;
  },
});

// @ts-expect-error: a host-only capability is still refused on a plugin
export const pluginWithHostOnly = server({ scope: 'plugin', capabilities: [dedup()] });

// @ts-expect-error: an unknown key is still refused on a plugin
export const pluginWithUnknownKey = server({ scope: 'plugin', nope: true });

// A hook in its own function reads its types through `context`.
function greet(): void {
  const ctx = context.connection(withSeparateHook);
  ctx.send('notification', { title: 'hi' });
  // @ts-expect-error: not a declared event
  ctx.send('nope', { title: 'x' });
}

export const withSeparateHook = server({ capabilities, onConnect: greet });

// The old registration methods are gone.
// @ts-expect-error: a hook goes in server({ ... })
app.onConnect(() => {});
// @ts-expect-error: an intercept goes in server({ ... })
app.intercept(() => {});
