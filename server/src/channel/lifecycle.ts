/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EngineAccess } from '~/_engine/access.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

/**
 * Handler called after a client subscribes to a channel. Receives only the
 * handler context — the subscription is already confirmed at this point.
 */
export type SubscribeHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * Handler called only on a TRUE leave — when the client sends `__unsubscribe__`,
 * is kicked, or is removed via `removeMember(identity)`. The user has left
 * the group; for persistent channels the durable membership row has been
 * deleted. NOT fired on plain disconnect of a persistent channel — that case
 * fires `onSessionEnd` instead.
 *
 * On ephemeral channels (no `persistence: true`, or `persistent: false` on the
 * channel) disconnect IS a true leave, so this hook fires together with
 * `onSessionEnd` for every leave path.
 */
export type UnsubscribeHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * Handler called whenever this specific connection's view of the channel
 * ends — true leave OR plain disconnect. Use this for cleaning up
 * per-session resources, decrementing an "online member" counter, or
 * anything tied to the live socket rather than group membership.
 */
export type SessionEndHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * An async function that runs before a client is allowed into a channel.
 * Use it for things like token validation or permission checks.
 *
 * Return any value — TypeScript infers the type and passes it as the second
 * argument of the paired `commit` handler. Throw to deny the subscribe.
 */
export type CheckHandler<TCtx = any, TData = unknown, TResult = unknown> = (
  ctx: TCtx,
  data?: TData,
) => TResult | Promise<TResult>;

/**
 * A function that re-authorizes an existing durable membership on auto-rejoin.
 * Runs only when a reconnecting identity is restored to a persistent channel —
 * never on a first subscribe. Receives only the context (no subscribe payload).
 * Throw to revoke the membership: the durable row is dropped and the connection
 * is not brought back into the channel. Return value is ignored.
 */
export type RevalidateHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * A synchronous function that runs right before the subscriber is added to the channel.
 * Receives the value returned by `check` as `checkResult`.
 *
 * Use it for final checks like enforcing a capacity limit.
 * Must be synchronous — do not return a `Promise`. Throw to deny the subscribe.
 */
export type CommitHandler<TCtx = any, TCheck = unknown> = (ctx: TCtx, checkResult: TCheck) => void;

/** Primitive produced by `check()`. */
export interface CheckPrimitive<
  TCtx = any,
  TData = unknown,
  TResult = unknown,
> extends Primitive<'check'> {
  readonly handler: CheckHandler<TCtx, TData, TResult>;
  /** Optional schema that validates the subscribe payload before the handler runs. */
  readonly validator?: Validator<TData>;
}

/** Primitive produced by `commit()`. */
export interface CommitPrimitive<TCtx = any, TCheck = unknown> extends Primitive<'commit'> {
  readonly handler: CommitHandler<TCtx, TCheck>;
}

/** Primitive produced by `revalidate()`. */
export interface RevalidatePrimitive<TCtx = any> extends Primitive<'revalidate'> {
  readonly handler: RevalidateHandler<TCtx>;
}

/** Primitive type produced by `onSubscribe()`. */
export interface SubscribePrimitive<TCtx = any> extends Primitive<'onSubscribe'> {
  readonly handler: SubscribeHandler<TCtx>;
}

/** Primitive type produced by `onUnsubscribe()`. */
export interface UnsubscribePrimitive<TCtx = any> extends Primitive<'onUnsubscribe'> {
  readonly handler: UnsubscribeHandler<TCtx>;
}

/** Primitive type produced by `onSessionEnd()`. */
export interface SessionEndPrimitive<TCtx = any> extends Primitive<'onSessionEnd'> {
  readonly handler: SessionEndHandler<TCtx>;
}

const ON_CHECK_KEY = Symbol('check');
const ON_REVALIDATE_KEY = Symbol('revalidate');
const ON_COMMIT_KEY = Symbol('commit');
const ON_SUBSCRIBE_KEY = Symbol('onSubscribe');
const ON_UNSUBSCRIBE_KEY = Symbol('onUnsubscribe');
const ON_SESSION_END_KEY = Symbol('onSessionEnd');

/**
 * Run an async check before a client is allowed into a channel.
 *
 * Return any value — TypeScript infers the type and passes it as the second
 * argument to the paired `commit` handler. Throw to deny the subscribe.
 *
 * Pass a `subscribe` schema on the channel config to validate the subscribe
 * payload first; the validated value is read off `ctx.check`.
 *
 * @example
 * ```ts
 * import { Block } from '@wskit/server/errors';
 *
 * base.channel('private-room', {
 *   subscribe: v.object({ token: v.string() }),
 *   async check(ctx) {
 *     const user = await db.verifyToken(ctx.check.token);
 *     if (!user) throw Forbidden({ reason: 'Invalid token' });
 *     return user; // passed to commit() below
 *   },
 *   commit(ctx, user) {
 *     if (ctx.channel.members().length >= 50) {
 *       throw Block;
 *     }
 *   },
 * });
 * ```
 */
export function check<TCtx, TData = unknown, TResult = unknown>(
  handler: CheckHandler<TCtx, TData, TResult>,
  options?: { validator?: Validator<TData> },
): CheckPrimitive<TCtx, TData, TResult> {
  return {
    __wskit: 'check',
    __kind: 'lifecycle',
    __identity: [ON_CHECK_KEY],
    __requires: {},
    handler,
    validator: options?.validator,
    __setup(engine: EngineAccess) {
      engine.onCheck(handler as CheckHandler, options?.validator);
    },
  };
}

/**
 * Re-authorize a durable membership when a reconnecting identity is auto-rejoined
 * to a persistent channel. Runs only on auto-rejoin — never on a first subscribe,
 * so it gets no subscribe payload. Throw to revoke: the durable row is dropped and
 * the connection is not restored to the channel.
 *
 * Use it for revocation that must take effect across reconnects — a ban, a lapsed
 * permission, a closed room. First-subscribe authorization stays in `check`.
 *
 * @example
 * ```ts
 * base.channel('archive-room', {
 *   async check(ctx) {
 *     if (await isBanned(ctx.meta.username)) throw Forbidden();
 *   },
 *   async revalidate(ctx) {
 *     if (await isBanned(ctx.meta.username)) throw Forbidden();
 *   },
 * });
 * ```
 */
export function revalidate<TCtx>(handler: RevalidateHandler<TCtx>): RevalidatePrimitive<TCtx> {
  return {
    __wskit: 'revalidate',
    __kind: 'lifecycle',
    __identity: [ON_REVALIDATE_KEY],
    __requires: {},
    handler,
    __setup(engine: EngineAccess) {
      engine.onRevalidate(handler as RevalidateHandler);
    },
  };
}

/**
 * Creates a `commit` lifecycle primitive for a channel.
 *
 * Run a final sync check right before the subscriber is added to the channel.
 *
 * Receives the value returned by `check` — TypeScript knows the type.
 * Use it for things like capacity limits. Throw to deny the subscribe.
 *
 * Must be synchronous. Do not use `async` or return a `Promise`.
 *
 * @example
 * ```ts
 * base.channel('private-room', {
 *   commit(ctx) {
 *     if (ctx.channel.members().length >= 50) {
 *       throw Block(error('room-full')());
 *     }
 *   },
 * });
 * ```
 */
export function commit<TCtx, TCheck = unknown>(
  handler: CommitHandler<TCtx, TCheck>,
): CommitPrimitive<TCtx, TCheck> {
  return {
    __wskit: 'commit',
    __kind: 'lifecycle',
    __identity: [ON_COMMIT_KEY],
    __requires: {},
    handler,
    __setup(engine: EngineAccess) {
      engine.onCommit(handler as CommitHandler);
    },
  };
}

/**
 * Creates an `onSubscribe` lifecycle primitive for a channel. The handler runs
 * after the subscription is confirmed. Use this to send initial state to the
 * newly subscribed client.
 *
 * @example
 * ```ts
 * const notifications = base.channel('notifications', {
 *   outgoing: { emits: { notifications: t<Item[]>() } },
 * });
 * notifications.subscribe(async (ctx) => {
 *   const items = await db.getUnread(ctx.meta.userId);
 *   ctx.channel.send('notifications', items);
 * });
 * ```
 */
export function onSubscribe<TCtx>(handler: SubscribeHandler<TCtx>): SubscribePrimitive<TCtx> {
  return {
    __wskit: 'onSubscribe',
    __kind: 'lifecycle',
    __identity: [ON_SUBSCRIBE_KEY],
    __requires: {},
    handler,
    __setup(engine: EngineAccess) {
      engine.onSubscribe(handler as SubscribeHandler);
    },
  };
}

/**
 * Creates an `onUnsubscribe` lifecycle primitive for a channel. The handler
 * runs only on a TRUE leave — `__unsubscribe__`, kick, or `removeMember`.
 * Not fired on plain disconnect of a persistent channel (`onSessionEnd` fires there instead).
 * Use this for cleanup, presence tracking, or releasing locks.
 */
export function onUnsubscribe<TCtx>(handler: UnsubscribeHandler<TCtx>): UnsubscribePrimitive<TCtx> {
  return {
    __wskit: 'onUnsubscribe',
    __kind: 'lifecycle',
    __identity: [ON_UNSUBSCRIBE_KEY],
    __requires: {},
    handler,
    __setup(engine: EngineAccess) {
      engine.onUnsubscribe(handler as UnsubscribeHandler);
    },
  };
}

/**
 * Creates an `onSessionEnd` lifecycle primitive for a channel. The handler
 * runs whenever this connection's view of the channel ends — a true leave
 * (`__unsubscribe__`, kick, `removeMember`) OR a plain disconnect. Use this
 * for per-session cleanup or for counting active connections.
 */
export function onSessionEnd<TCtx>(handler: SessionEndHandler<TCtx>): SessionEndPrimitive<TCtx> {
  return {
    __wskit: 'onSessionEnd',
    __kind: 'lifecycle',
    __identity: [ON_SESSION_END_KEY],
    __requires: {},
    handler,
    __setup(engine: EngineAccess) {
      engine.onSessionEnd(handler as SessionEndHandler);
    },
  };
}

/** Symbol key used to reference `check` in dependency declarations. */
check.__key = ON_CHECK_KEY;
/** Symbol key used to reference `revalidate` in dependency declarations. */
revalidate.__key = ON_REVALIDATE_KEY;
/** Symbol key used to reference `commit` in dependency declarations. */
commit.__key = ON_COMMIT_KEY;
/** Symbol key used to reference `onSubscribe` in dependency declarations. */
onSubscribe.__key = ON_SUBSCRIBE_KEY;
/** Symbol key used to reference `onUnsubscribe` in dependency declarations. */
onUnsubscribe.__key = ON_UNSUBSCRIBE_KEY;
/** Symbol key used to reference `onSessionEnd` in dependency declarations. */
onSessionEnd.__key = ON_SESSION_END_KEY;
