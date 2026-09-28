import { ADMIN_CONTEXT_MEMBERS } from '@livething/server/adapters';
import { RpcTarget } from 'cloudflare:workers';
import type {
  AdminContext,
  ConnectionInfo,
  ConnectionRef,
  PurgeUserOptions,
  TagRef,
  UserRef,
} from '@livething/server/adapters';

type FilterParameter = { userId?: string };
type OptsParameter = { reason: string; revoke?: boolean };

/** A channel address: a static channel name, or a family plus instance name. */
export type AdminChannelTarget = string | { readonly family: string; readonly instance: string };

/**
 * A live connection as seen from the Worker — {@link ConnectionInfo} without its
 * `ref()` method, since only data survives the trip out of the Durable Object.
 * Use the `id` with `sendToConnection`, which resolves the ref inside the DO.
 */
export type AdminConnectionInfo<TMeta = Record<string, never>> = Omit<ConnectionInfo<TMeta>, 'ref'>;

/** Drop the methods a snapshot carries so it can be structured-cloned to the Worker. */
function toPlainInfo<TMeta>(info: ConnectionInfo<TMeta>): AdminConnectionInfo<TMeta> {
  const { ref: _ref, ...plain } = info;
  return plain;
}

/**
 * The connectionless admin surface reached with `stub.admin()`. Extends
 * `RpcTarget` so its methods are callable across the Worker→DO stub. The
 * framework's built-in operations are declared here; the app's own `api`
 * methods (authored on `assemble({ handlers, api })`) are attached per instance.
 * Built-in names win — an app api method cannot shadow one.
 *
 * Every operation is a **method**, and every value it returns is plain data.
 * A Worker→DO call structured-clones its result and exposes only what is on the
 * prototype chain, so the context's managers (`connections`, `users`,
 * `channels`) cannot cross as-is — each is projected onto a flat method here.
 * In-process adapters have no such boundary and hand back the context whole.
 *
 * The dev `api` factory still runs against the full context (channels, tags,
 * sql, and the rest) inside the Durable Object; that richness is for use inside
 * your api methods, not for surfacing directly over the stub.
 */
export class LiveThingAdmin<TMeta = Record<string, never>> extends RpcTarget {
  readonly #ctx: AdminContext<TMeta>;
  readonly #instanceId: string | undefined;

  constructor(ctx: AdminContext<TMeta>, instanceId?: string) {
    super();
    this.#ctx = ctx;
    this.#instanceId = instanceId;
  }

  /**
   * A ref crossing the Worker → DO RPC boundary cannot retain the instance
   * field when it was created by an older/single-instance caller. Treat an
   * omitted instance as local to this admin surface; an explicit other id is
   * left intact so the engine can reject it rather than silently rerouting.
   */
  #localTarget(target: UserRef | TagRef): UserRef | TagRef {
    if (target.__livething !== 'user-ref' || target.instance !== undefined) return target;

    if (this.#instanceId === undefined) return target;

    return { ...target, instance: this.#instanceId };
  }

  /** Resolve one live connection's ref by id, so the Worker never forges one. */
  #refOf(connectionId: string): ConnectionRef | undefined {
    return this.#ctx.connections
      .all()
      .find((info) => info.id === connectionId)
      ?.ref();
  }

  #channel(target: AdminChannelTarget) {
    return typeof target === 'string'
      ? this.#ctx.channels.get(target)
      : this.#ctx.channels.get(target.family, target.instance);
  }

  /** Broadcast an event to every live connection. */
  broadcast(event: string, payload: unknown): void {
    this.#ctx.broadcast(event, payload);
  }

  /**
   * Drop a user everywhere: channels, durable rows, and their live sockets.
   *
   * Pass `{ keepBroadcastContent: true }` to leave the content of broadcast
   * streams the user created in place. Either way they stop being credited as
   * its creator.
   */
  purgeUser(userId: string, options?: PurgeUserOptions): Promise<void> {
    return this.#ctx.purgeUser(userId, options);
  }

  /** Close live connections — all of them, or only one user's. */
  closeConnections(filter?: FilterParameter, code?: number, reason?: string): void {
    this.#ctx.closeConnections(filter, code, reason);
  }

  /** The number of live connections at the moment of the call. */
  connectionCount(): number {
    return this.#ctx.connectionCount;
  }

  /** A snapshot of every live connection. */
  listConnections(): AdminConnectionInfo<TMeta>[] {
    return this.#ctx.connections.all().map(toPlainInfo);
  }

  /**
   * Send to one connection by id. Returns `false` when no live connection on
   * this instance holds that id.
   */
  sendToConnection(connectionId: string, event: string, payload: unknown): boolean {
    const ref = this.#refOf(connectionId);
    if (!ref) return false;

    return this.#ctx.connections.get(ref).send(event, payload);
  }

  /** Send to every live connection a user holds. Returns how many got it. */
  sendToUser(userId: string, event: string, payload: unknown): number {
    return this.#ctx.users.get(userId).broadcast(event, payload);
  }

  /** Close every live connection a user holds. */
  closeUser(userId: string, code?: number, reason?: string): void {
    this.#ctx.users.get(userId).close(code, reason);
  }

  /** Broadcast to one channel's members. */
  channelBroadcast(channel: AdminChannelTarget, event: string, payload: unknown): void {
    this.#channel(channel).broadcast(event, payload);
  }

  /** A snapshot of one channel's members. */
  channelMembers(channel: AdminChannelTarget): AdminConnectionInfo<TMeta>[] {
    return this.#channel(channel).members().map(toPlainInfo);
  }

  /** Remove a user, or everyone holding a tag, from one channel. */
  channelKick(
    channel: AdminChannelTarget,
    target: UserRef | TagRef,
    opts: OptsParameter,
  ): Promise<void> {
    return this.#channel(channel).kick(this.#localTarget(target), opts);
  }
}

/**
 * Project an `Engine.admin()` surface onto a {@link LiveThingAdmin}. The app's own
 * api methods go on a per-call subclass prototype — Cloudflare RPC only exposes
 * methods found on the prototype chain, not own properties — and a method that
 * collides with a built-in is dropped, so built-ins always win.
 *
 * The engine merges the app's api into the admin context, so a key outside
 * `ADMIN_CONTEXT_MEMBERS` is what the app itself contributed. An api method
 * named `then` is rejected outright rather than silently dropped: `then` would
 * make `await stub.admin()` hang forever, and that failure mode is worse than
 * a clear error at the moment the admin surface is built.
 */
export function buildAdmin<TApi, TMeta>(
  surface: AdminContext<TMeta> & TApi,
  instanceId?: string,
): LiveThingAdmin<TMeta> & TApi {
  const devMethods = Object.entries(surface as Record<string, unknown>).filter(
    (entry) =>
      typeof entry[1] === 'function' &&
      !ADMIN_CONTEXT_MEMBERS.has(entry[0]) &&
      !(entry[0] in LiveThingAdmin.prototype),
  );
  if (devMethods.length === 0) {
    return new LiveThingAdmin(surface, instanceId) as LiveThingAdmin<TMeta> & TApi;
  }

  const Extended = class extends LiveThingAdmin<TMeta> {};
  const proto = Extended.prototype as unknown as Record<string, unknown>;
  for (const [key, value] of devMethods) {
    proto[key] = value;
  }

  return new Extended(surface, instanceId) as LiveThingAdmin<TMeta> & TApi;
}
