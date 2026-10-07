/* oxlint-disable @typescript-eslint/no-explicit-any */
import { getCurrentCall } from '~/_engine/call-context.ts';
import type { AppCtx } from '~/_define/app-ctx.ts';
import type { CoreBase } from '~/_define/server.ts';
import type { CallKind } from '~/_engine/call-context.ts';
import type { InitContext, ShutdownContext, TaskContext } from '~/context.ts';

/** What `server(...)` returns: the app's base, or a plugin's own `server({ scope: 'plugin' })` base. */
type BaseRef = CoreBase<any, any, any, any>;

/** What `base.channel(...)` returns, as far as the accessors need it. */
type ChannelRef = { readonly __key: string; readonly __baseId: symbol | undefined };

type ConnectionCtxOf<TBase> =
  TBase extends CoreBase<infer S, infer M, infer C, any> ? AppCtx<S, M, C> : never;

type TaskCtxOf<TBase> = TBase extends CoreBase<any, infer M, any, any> ? TaskContext<M> : never;

type ShutdownCtxOf<TBase> =
  TBase extends CoreBase<infer S, infer M, any, any> ? ShutdownContext<M, unknown, S> : never;

/** The `ctx` a channel's own handlers receive, read off the `run` parameter of its `on` method. */
type ChannelCtxOf<TChannel> = TChannel extends { on: (...args: infer A) => any }
  ? A[1] extends { run: (ctx: infer C, ...rest: any[]) => any }
    ? C
    : never
  : never;

/** The `ctx` a channel's `subscribe`, `unsubscribe` and `sessionEnd` hooks receive. */
type ChannelLifecycleCtxOf<TChannel> = TChannel extends { subscribe: (...args: infer A) => any }
  ? A[0] extends (ctx: infer C) => any
    ? C
    : never
  : never;

/** The `ctx` a channel's `check`, `commit` and `revalidate` hooks receive. */
type ChannelGateCtxOf<TChannel> = TChannel extends { __gateCtx?: infer C } ? NonNullable<C> : never;

interface Expected {
  accessor: string;
  kind: CallKind;
  baseId?: symbol;
  channelKey?: string;
}

function currentCtx(expected: Expected): unknown {
  const { accessor, kind } = expected;
  const call = getCurrentCall();
  if (!call) {
    throw new Error(
      `[livething] context.${accessor}() was called outside a LiveThing handler or hook. ` +
        'It works only in code that runs inside a handler or hook, including its async continuations. ' +
        'Pass ctx down explicitly from code that runs outside an invocation.',
    );
  }

  if (call.kind !== kind) {
    throw new Error(
      `[livething] context.${accessor}() was called while LiveThing runs a '${call.kind}' invocation. ` +
        `Use context.${call.kind}() there.`,
    );
  }

  if (expected.baseId !== undefined && call.baseId !== expected.baseId) {
    throw new Error(
      `[livething] context.${accessor}() was given a base that is not the one running now. ` +
        "Pass the `server(...)` result that the running code belongs to: the app's base in the app's code, " +
        "or a plugin's own base in that plugin's code.",
    );
  }

  if (expected.channelKey !== undefined && call.channelKey !== expected.channelKey) {
    throw new Error(
      `[livething] context.${accessor}() was given a channel that is not the one running now (running: '${call.channelKey}'). ` +
        'Pass the channel whose handler or hook is running.',
    );
  }

  return call.getCtx();
}

/**
 * Read the `ctx` of the handler or hook that is running now, without passing it
 * down through every function call. Each accessor takes the `server(...)` result
 * (or the channel) and returns the same `ctx` type that a handler of that server
 * (or channel) receives.
 *
 * An accessor throws when it is called outside an invocation, during a different
 * kind of invocation, or with a `base` that belongs to another server.
 *
 * Inside a plugin's own code, pass the plugin's `base` and channels. The accessor then
 * returns the plugin's scoped `ctx`, the same one its handlers and hooks receive.
 *
 * ```ts
 * function requireAdmin() {
 *   const ctx = context.connection(huddleBase);
 *   if (ctx.meta.role !== 'admin') throw new Error('admins only');
 * }
 * ```
 */
export const context = {
  /**
   * The `ctx` of a top-level event, request or stream handler, a top-level intercept, and the
   * `onConnect`, `onDisconnect`, `onPing`, `onPong`, `onError` and `onValidationError` hooks.
   * The type has no `ctx.stream`, which only a stream handler's own `ctx` carries.
   */
  connection<TBase extends BaseRef>(base: TBase): ConnectionCtxOf<TBase> {
    return currentCtx({
      accessor: 'connection',
      kind: 'connection',
      baseId: base.__baseId,
    }) as ConnectionCtxOf<TBase>;
  },

  /** The `ctx` of a scheduled task handler. */
  task<TBase extends BaseRef>(base: TBase): TaskCtxOf<TBase> {
    return currentCtx({
      accessor: 'task',
      kind: 'task',
      baseId: base.__baseId,
    }) as TaskCtxOf<TBase>;
  },

  /** The `ctx` of an `onInit` hook. */
  init<TBase extends BaseRef>(base: TBase): InitContext {
    return currentCtx({ accessor: 'init', kind: 'init', baseId: base.__baseId }) as InitContext;
  },

  /** The `ctx` of an `onShutdown` hook. */
  shutdown<TBase extends BaseRef>(base: TBase): ShutdownCtxOf<TBase> {
    return currentCtx({
      accessor: 'shutdown',
      kind: 'shutdown',
      baseId: base.__baseId,
    }) as ShutdownCtxOf<TBase>;
  },

  /**
   * The `ctx` of an `upgrade` function.
   */
  upgrade<TBase extends BaseRef>(base: TBase): InitContext {
    return currentCtx({
      accessor: 'upgrade',
      kind: 'upgrade',
      baseId: base.__baseId,
    }) as InitContext;
  },

  /**
   * The `ctx` of an event, request or stream handler of one channel, and of an `intercept` of
   * that channel. The type has no `ctx.stream`, which only a stream handler's own `ctx` carries.
   */
  channel<TChannel extends ChannelRef & { on: unknown }>(
    channel: TChannel,
  ): ChannelCtxOf<TChannel> {
    return currentCtx({
      accessor: 'channel',
      kind: 'channel',
      baseId: channel.__baseId,
      channelKey: channel.__key,
    }) as ChannelCtxOf<TChannel>;
  },

  /**
   * The `ctx` of a channel's `subscribe`, `unsubscribe` or `sessionEnd` hook. It has the
   * channel-only handles (`ctx.channel.inbox`, `readReceipts`, `request` and
   * `broadcastRequest`) when the channel has them. Call it in a `check`, `commit` or
   * `revalidate` hook and it throws; use `context.channelGate(channel)` there.
   */
  channelLifecycle<TChannel extends ChannelRef & { subscribe: unknown }>(
    channel: TChannel,
  ): ChannelLifecycleCtxOf<TChannel> {
    return currentCtx({
      accessor: 'channelLifecycle',
      kind: 'channelLifecycle',
      baseId: channel.__baseId,
      channelKey: channel.__key,
    }) as ChannelLifecycleCtxOf<TChannel>;
  },

  /**
   * The `ctx` of a channel's `check`, `commit` or `revalidate` hook. The type has no
   * `ctx.channel.inbox`, `readReceipts`, `request` or `broadcastRequest`, because those hooks
   * do not have them. Call it in a `subscribe`, `unsubscribe` or `sessionEnd` hook and it
   * throws; use `context.channelLifecycle(channel)` there.
   */
  channelGate<TChannel extends ChannelRef & { subscribe: unknown }>(
    channel: TChannel,
  ): ChannelGateCtxOf<TChannel> {
    return currentCtx({
      accessor: 'channelGate',
      kind: 'channelGate',
      baseId: channel.__baseId,
      channelKey: channel.__key,
    }) as ChannelGateCtxOf<TChannel>;
  },
};
