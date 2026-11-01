import { ADMIN_CONTEXT_MEMBERS } from '@livething/server/adapters';
import { RpcTarget } from 'cloudflare:workers';
import type {
  ApiOf,
  ChannelBroadcastArgs,
  ConnectionInfo,
  ConnectionlessContext,
  ConnectionRef,
  MetaOf,
  PurgeUserOptions,
  ServerContract,
  ServerDefinition,
  TagRef,
  UserInfo,
  UserRef,
} from '@livething/server/adapters';

type CloseFilter = { userId?: string };
type KickOptions = { reason: string };

/**
 * Every `[event, payload]` pair an emits map allows, as a union of tuples.
 *
 * Workers RPC types a stub method from its parameter list, which drops a
 * method's generics. A rest parameter that is a union of tuples has no
 * generics to drop, so the stub still ties each payload to its event.
 */
type EventArgs<TOutgoing> = {
  [E in keyof TOutgoing & string]: [event: E, payload: TOutgoing[E]];
}[keyof TOutgoing & string];

/** `get(name)` for a static channel or `get(family, instance)` for one channel of a family. */
type ChannelGetArgs<TChannels> =
  | [name: keyof TChannels & string]
  | [family: keyof TChannels & string, instance: string];

type AnyArgs = [event: string, payload: unknown];

/** One connection, reached with `admin.connections.get(ref)`. */
class AdminConnection<TArgs extends AnyArgs> extends RpcTarget {
  readonly #ctx: ConnectionlessContext;
  readonly #ref: ConnectionRef;
  readonly #instanceId: string;

  constructor(ctx: ConnectionlessContext, ref: ConnectionRef, instanceId: string) {
    super();
    this.#ctx = ctx;
    this.#ref = ref;
    this.#instanceId = instanceId;
  }

  #handle() {
    if (this.#ref === null || typeof this.#ref !== 'object') {
      throw new Error(
        `[livething] admin.connections.get(ref) needs a connection ref, got ${String(this.#ref)}. Get one from admin.connections.all().`,
      );
    }

    return this.#ctx.connections.get(
      this.#ref.instance === undefined ? { ...this.#ref, instance: this.#instanceId } : this.#ref,
    );
  }

  /** Send an event to this connection only. `false` when it is no longer live. */
  send(...[event, payload]: TArgs): boolean {
    return this.#handle().send(event, payload);
  }

  /** Close this connection only. */
  close(code?: number, reason?: string): void {
    this.#handle().close(code, reason);
  }
}

/** `admin.connections`: reach one connection by ref, or snapshot them all. */
class AdminConnections<TArgs extends AnyArgs, TMeta> extends RpcTarget {
  readonly #ctx: ConnectionlessContext;
  readonly #instanceId: string;

  constructor(ctx: ConnectionlessContext, instanceId: string) {
    super();
    this.#ctx = ctx;
    this.#instanceId = instanceId;
  }

  /**
   * Reach one connection by ref. A ref built in the Worker has no instance id,
   * so it is treated as local to this Durable Object. A bad ref throws from the
   * later call, for the reason given on {@link AdminChannels.get}.
   */
  get(ref: ConnectionRef): AdminConnection<TArgs> {
    return new AdminConnection(this.#ctx, ref, this.#instanceId);
  }

  /** A snapshot of every live connection. Each `ref()` crosses the stub as a callable stub. */
  all(): ConnectionInfo<TMeta>[] {
    return this.#ctx.connections.all() as ConnectionInfo<TMeta>[];
  }
}

/** One user — every live socket they hold — reached with `admin.users.get(id)`. */
class AdminUser<TArgs extends AnyArgs, TMeta> extends RpcTarget {
  readonly #ctx: ConnectionlessContext;
  readonly #id: string;

  constructor(ctx: ConnectionlessContext, id: string) {
    super();
    this.#ctx = ctx;
    this.#id = id;
  }

  get id(): string {
    return this.#id;
  }

  ref(): UserRef {
    return this.#ctx.users.get(this.#id).ref();
  }

  /** Send an event to every live socket the user holds. Returns how many got it. */
  broadcast(...[event, payload]: TArgs): number {
    return this.#ctx.users.get(this.#id).broadcast(event, payload);
  }

  setMeta(patch: Partial<TMeta>): void {
    this.#ctx.users.get(this.#id).setMeta(patch);
  }

  connections(): ConnectionInfo<TMeta>[] {
    return this.#ctx.users.get(this.#id).connections() as ConnectionInfo<TMeta>[];
  }

  close(code?: number, reason?: string): void {
    this.#ctx.users.get(this.#id).close(code, reason);
  }

  info(): UserInfo<TMeta> | null {
    return this.#ctx.users.get(this.#id).info() as UserInfo<TMeta> | null;
  }

  /** Whether the user has a live connection on this Durable Object. */
  isOnline(): boolean {
    return this.#ctx.users.get(this.#id).isOnline();
  }
}

/** `admin.users`: reach any user by id. */
class AdminUsers<TArgs extends AnyArgs, TMeta> extends RpcTarget {
  readonly #ctx: ConnectionlessContext;

  constructor(ctx: ConnectionlessContext) {
    super();
    this.#ctx = ctx;
  }

  get(id: string): AdminUser<TArgs, TMeta> {
    return new AdminUser(this.#ctx, id);
  }
}

/**
 * One channel, reached with `admin.channels.get(...)`. To broadcast, use
 * `admin.channels.broadcast(...)`: Workers RPC cannot carry which name was
 * passed to `get`, so a broadcast here could not be typed to this channel.
 */
class AdminChannel<TMeta> extends RpcTarget {
  readonly #ctx: ConnectionlessContext;
  readonly #target: [string] | [string, string];
  readonly #instanceId: string;

  constructor(ctx: ConnectionlessContext, target: [string] | [string, string], instanceId: string) {
    super();
    this.#ctx = ctx;
    this.#target = target;
    this.#instanceId = instanceId;
  }

  #handle() {
    const [name, instance] = this.#target;
    return instance === undefined
      ? this.#ctx.channels.get(name)
      : this.#ctx.channels.get(name, instance);
  }

  /** A snapshot of the channel's members. */
  members(): ConnectionInfo<TMeta>[] {
    return this.#handle().members() as ConnectionInfo<TMeta>[];
  }

  /**
   * Remove a user, or everyone holding a tag, from this channel. A user ref
   * built in the Worker has no instance id, so it is treated as local to this
   * Durable Object. A ref that names another instance is passed on as it is,
   * so the engine rejects it.
   */
  kick(target: UserRef | TagRef, opts: KickOptions): Promise<void> {
    const local =
      target.__livething === 'user-ref' && target.instance === undefined
        ? { ...target, instance: this.#instanceId }
        : target;
    return this.#handle().kick(local, opts);
  }
}

/**
 * `admin.channels`: reach a channel by name, or by family and instance name,
 * or broadcast to one channel.
 */
class AdminChannels<TChannels, TMeta> extends RpcTarget {
  readonly #ctx: ConnectionlessContext;
  readonly #instanceId: string;

  constructor(ctx: ConnectionlessContext, instanceId: string) {
    super();
    this.#ctx = ctx;
    this.#instanceId = instanceId;
  }

  /**
   * An unknown channel throws `ChannelNotFound` from the later call, not here. A
   * Worker chains `get(...).members()` over RPC and never holds the promise for
   * `get`, so a throw here would be an unhandled rejection in the Worker even
   * when the chained call is inside try/catch.
   */
  get(...target: ChannelGetArgs<TChannels>): AdminChannel<TMeta> {
    const resolved: [string] | [string, string] =
      target[1] === undefined ? [target[0]] : [target[0], target[1]];
    return new AdminChannel(this.#ctx, resolved, this.#instanceId);
  }

  /**
   * Broadcast a channel event to that channel's members. Name a static channel
   * by its name, or a family's channel by `{ family, name }`.
   */
  broadcast(...[channel, event, payload]: ChannelBroadcastArgs<TChannels>): void {
    this.#ctx.channels.broadcast(channel, event, payload);
  }
}

/**
 * The admin surface `stub.admin()` returns. It has the same shape as the
 * in-process admin surface on Node (`admin.connections.all()`,
 * `admin.users.get(id).broadcast(...)`, `admin.channels.get(...)`, and the
 * rest), so the same code reads the same way on both runtimes.
 *
 * Workers RPC only sees what is on a class's prototype chain, so every nested
 * part is an `RpcTarget` reached through a getter or a method. Storage,
 * scheduling, the logger and the platform object (`sql`, `kv`, `schedule`,
 * `cancelScheduled`, `log`, `platform`) stay inside the Durable Object: use
 * them from your own `api` methods.
 */
class AdminTarget<TArgs extends AnyArgs, TChannels, TMeta> extends RpcTarget {
  readonly #ctx: ConnectionlessContext;
  readonly #instanceId: string;

  constructor(ctx: ConnectionlessContext, instanceId: string) {
    super();
    this.#ctx = ctx;
    this.#instanceId = instanceId;
  }

  get connections(): AdminConnections<TArgs, TMeta> {
    return new AdminConnections(this.#ctx, this.#instanceId);
  }

  get users(): AdminUsers<TArgs, TMeta> {
    return new AdminUsers(this.#ctx);
  }

  get channels(): AdminChannels<TChannels, TMeta> {
    return new AdminChannels(this.#ctx, this.#instanceId);
  }

  /** The number of live connections at the moment of the read. */
  get connectionCount(): number {
    return this.#ctx.connectionCount;
  }

  /** Broadcast an event to every live connection. */
  broadcast(...[event, payload]: TArgs): void {
    this.#ctx.broadcast(event, payload);
  }

  /**
   * Drop a user everywhere: channels, durable rows, and their live sockets.
   * Pass `{ keepBroadcastContent: true }` to keep the content of broadcast
   * streams the user created.
   */
  purgeUser(userId: string, options?: PurgeUserOptions): Promise<void> {
    return this.#ctx.purgeUser(userId, options);
  }

  /** Close live connections — all of them, or only one user's. */
  closeConnections(filter?: CloseFilter, code?: number, reason?: string): void {
    this.#ctx.closeConnections(filter, code, reason);
  }
}

type ContractOf<TDefinition> = TDefinition extends { readonly __contract?: infer TContract }
  ? NonNullable<TContract> extends ServerContract
    ? NonNullable<TContract>
    : ServerContract
  : ServerContract;

type HasKeys<T> = [keyof T] extends [never] ? false : true;

/** The function members of an `api`, the only ones {@link buildAdmin} puts on the stub. */
type ApiMethods<TApi> = {
  [K in keyof TApi as TApi[K] extends (...args: never[]) => unknown ? K : never]: TApi[K];
};

/**
 * What `stub.admin()` resolves to for one server definition. Event names and
 * payloads are checked against the definition's own `emits(...)`, exactly as
 * they are on Node, and `channels.broadcast` checks them against the named
 * channel's emits. `channels` is there only when the definition declares a channel.
 * Of the definition's `api`, only the methods are here: a stub can't carry a plain
 * value member, so read one through a method.
 */
export type CloudflareAdmin<TDefinition extends ServerDefinition = ServerDefinition> = Omit<
  AdminTarget<
    EventArgs<ContractOf<TDefinition>['outgoing']>,
    ContractOf<TDefinition>['channels'],
    MetaOf<TDefinition>
  >,
  HasKeys<ContractOf<TDefinition>['channels']> extends true ? never : 'channels'
> &
  ApiMethods<ApiOf<TDefinition>>;

/** Names a Workers RPC stub already uses, so an app `api` method by one of them is never reached. */
const RPC_STUB_NAMES: ReadonlySet<string> = new Set(['dup']);

/**
 * Project an `Engine.admin()` surface onto an {@link AdminTarget}. The app's own
 * api methods go on a per-call subclass prototype — Workers RPC only exposes
 * what is on the prototype chain, not own properties — and a method that
 * collides with a built-in is dropped, so built-ins always win.
 *
 * The engine merges the app's api into the connectionless context, so a key
 * outside `ADMIN_CONTEXT_MEMBERS` is what the app itself contributed. The
 * engine already rejects `then`. An api method named `dup` is rejected here,
 * because the Worker's stub has its own `dup()` and would never call it.
 */
export function buildAdmin(surface: ConnectionlessContext, instanceId: string): unknown {
  const devMethods = Object.entries(surface as unknown as Record<string, unknown>).filter(
    (entry) =>
      typeof entry[1] === 'function' &&
      !ADMIN_CONTEXT_MEMBERS.has(entry[0]) &&
      !(entry[0] in AdminTarget.prototype),
  );
  const reserved = devMethods.find((entry) => RPC_STUB_NAMES.has(entry[0]));
  if (reserved) {
    throw new Error(
      `[livething] The admin api method '${reserved[0]}' clashes with a Workers RPC stub method of the same name, so a Worker could never call it. Rename it.`,
    );
  }

  if (devMethods.length === 0) return new AdminTarget(surface, instanceId);

  const Extended = class extends AdminTarget<AnyArgs, unknown, unknown> {};
  const proto = Extended.prototype as unknown as Record<string, unknown>;
  for (const [key, value] of devMethods) {
    proto[key] = value;
  }

  return new Extended(surface, instanceId);
}
