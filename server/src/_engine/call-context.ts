import type { AsyncContext, AsyncContextFactory } from '~/context.ts';

/** The kinds of invocation the `context.*` accessors can resolve. */
export type CallKind =
  | 'connection'
  | 'channel'
  | 'channelGate'
  | 'channelLifecycle'
  | 'task'
  | 'init'
  | 'shutdown'
  | 'upgrade';

/** What one engine entry point tells the accessors about the code it is running. */
export interface CallDescriptor {
  readonly kind: CallKind;
  /** Builds (once) the same `ctx` the running handler or hook receives. */
  readonly getCtx: () => unknown;
  /** The channel's key, for the `channel`, `channelGate` and `channelLifecycle` kinds. */
  readonly channelKey?: string;
  /** The `base` this code belongs to, when it is not the app's own (a plugin's `upgrade` hook). */
  readonly baseId?: symbol;
}

export interface CallContext extends CallDescriptor {
  /** Id of the `base` that assembled the running definition. */
  readonly baseId: symbol | undefined;
}

/**
 * One store per process, created from the first engine's adapter-supplied
 * factory. The `context.*` accessors live in the root package, which cannot
 * import `node:async_hooks` itself, so every engine in the process shares this
 * store and each call carries its own `baseId`.
 */
let callAsyncContext: AsyncContext<CallContext | undefined> | undefined;

export function registerCallContext(factory: AsyncContextFactory): void {
  callAsyncContext ??= factory<CallContext | undefined>();
}

export function runInCall<T>(call: CallContext, fn: () => T): T {
  return callAsyncContext ? callAsyncContext.run(call, fn) : fn();
}

/** Run `fn` with no call context, so `context.*` throws inside it instead of reading the caller's `ctx`. */
export function runOutsideCall<T>(fn: () => T): T {
  return callAsyncContext ? callAsyncContext.run(undefined, fn) : fn();
}

export function getCurrentCall(): CallContext | undefined {
  return callAsyncContext?.getStore();
}

/** Forget the shared store so the next engine registers its own. For tests that mix factories. */
export function resetCallContextForTests(): void {
  callAsyncContext = undefined;
}
