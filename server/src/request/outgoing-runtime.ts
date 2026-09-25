/* oxlint-disable @typescript-eslint/no-explicit-any */
import { Disconnected, LiveThingError, RequestInvalidResponse, Timeout } from '@livething/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import { ENGINE_CHANNEL_META } from '~/_engine/contexts/contexts.ts';
import { assertLocalRef } from '~/_engine/runtime/refs.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as PublicApi from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { ResolvedServerRequest } from '~/request/capability.ts';
import type { Validator } from '~/types.ts';

type ValueParameter = { response: unknown; from: PublicApi.ConnectionRef };
type ChannelDeclarationKeyHandleParameter = { name?: string; family?: unknown };
type SettleFrameParameter = {
  event: string;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
};
type SettleBroadcastLegArgsParameter = {
  connectionId: string;
  correlationId: string;
  entry: Extract<PendingServerRequest, { kind: 'broadcast' }>;
  frame: { event: string; payload: unknown };
};
type SendRequestArgsParameter = {
  target: {
    connectionId: string;
    channel?: string;
    channelFamily?: string | null;
    /** The channel definition key whose declarations to resolve, or null for top-level. */
    declarationChannelKey?: string | null;
  };
  event: string;
  payload: unknown;
  options: RequestOptions | undefined;
};
type SendBroadcastRequestArgsParameter = {
  targets: ReadonlyArray<{ connectionId: string; from: PublicApi.ConnectionRef }>;
  event: string;
  payload: unknown;
  options: RequestOptions | undefined;
  routing?: { channel?: string; channelFamily?: string | null };
  /** The channel definition key whose declarations to resolve, or null for top-level. */
  declarationChannelKey?: string | null;
};

function RequestNotDeclared(
  event: string,
): LiveThingError<'request-not-declared', { event: string }> {
  return new LiveThingError('request-not-declared', { event });
}

/** The built-in wait for a server→client request answer, in ms. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * One in-flight server→client exchange awaiting an answer, keyed by
 * correlationId. A `targeted` entry is one `ctx.request(...)`; a `broadcast`
 * entry is one leg of a `ctx.broadcastRequest(...)` fan-out — many legs share a
 * single `group` so the first valid answer wins and the rest are dropped.
 */
type PendingServerRequest =
  | {
      kind: 'targeted';
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
      connectionId: string;
      /** The event name, used to tag a `request-invalid-response` rejection. */
      event: string;
      /** The schema the client's answer is validated against, when one is declared. */
      responseValidator?: Validator;
    }
  | {
      kind: 'broadcast';
      connectionId: string;
      /** The connection ref of this leg's target, returned as `from` when it wins. */
      from: PublicApi.ConnectionRef;
      /** The shared race state every leg of this broadcast points at. */
      group: BroadcastGroup;
    };

/** The shared race state for one `broadcastRequest` fan-out. */
interface BroadcastGroup {
  resolve: (value: ValueParameter) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The event name, for the (unused-on-broadcast) invalid path symmetry. */
  event: string;
  /** Validates each leg's answer; an answer that fails it is ignored, not a win. */
  responseValidator?: Validator;
  /** The correlationIds of every still-pending leg, cleared once a winner lands. */
  legs: Set<string>;
  /** True once a winner has resolved the group, so late answers are ignored. */
  settled: boolean;
}

/** Per-request options accepted by every server→client request surface. */
interface RequestOptions {
  timeout?: number;
}

/** Per-broadcast-request options: a timeout plus self-exclusion control. */
interface BroadcastRequestOptions extends RequestOptions {
  /** Include the calling connection in the fan-out (default false). */
  includeSelf?: boolean;
}

/**
 * Compose the lookup key for one server→client request declaration. Keyed by
 * `[channelKey, event]` (channelKey is `null` for a top-level `serverRequests({...})`
 * declaration, or the channel's family key / static name for a channel `serverRequests(...)`
 * declaration), JSON-encoded so two channels can declare the same event name — and a
 * channel can reuse a top-level name — without clobbering each other. JSON keeps
 * the key unambiguous for any name without relying on a reserved separator.
 */
export function serverRequestKey(channelKey: string | null, event: string): string {
  return JSON.stringify([channelKey, event]);
}

/**
 * The channel-definition key for a runtime channel handle: its family key for a
 * dynamic channel, its static name otherwise — matching how `serverRequests()` keys
 * the channel's own `serverRequests(...)` declarations. Top-level surfaces pass `null`.
 */
function channelDeclarationKey(handle: ChannelDeclarationKeyHandleParameter): string {
  return typeof handle.family === 'string' ? handle.family : (handle.name ?? '');
}

/** A handle that can list its members and fan out a broadcast request. */
interface MemberHandle {
  connections(): PublicApi.ConnectionInfo[];
  broadcastRequest?: (event: string, payload: unknown, options?: RequestOptions) => unknown;
}

/** The broadcast arm of the outgoing-request runtime, used by the surface wiring. */
type BroadcastSender = Pick<
  ReturnType<typeof createOutgoingRequestRuntime>,
  'sendBroadcastRequest'
>;

/**
 * Map a member snapshot to broadcast targets — `from` is each member's ref so
 * the winner's identity is reported back. Pass `excludeId` to drop the calling
 * connection (mirrors `ctx.broadcast` excluding self at the top level).
 */
function membersToTargets(
  members: readonly PublicApi.ConnectionInfo[],
  excludeId?: string,
): ReadonlyArray<{ connectionId: string; from: PublicApi.ConnectionRef }> {
  const targets: Array<{ connectionId: string; from: PublicApi.ConnectionRef }> = [];
  for (const member of members) {
    if (excludeId !== undefined && member.id === excludeId) continue;

    targets.push({ connectionId: member.id, from: member.ref() });
  }

  return targets;
}

/**
 * Whether a member snapshot satisfies a channel-scoped `to` recipient. A
 * `user-ref` matches on the member's `userId`, mirroring `userKeyOf` on the
 * live connection. An anonymous member has `userId === ''` — no user identity
 * at all — and never matches, even when a `UserRef` id happens to equal its
 * connection id.
 */
function infoMatchesRecipient(
  info: PublicApi.ConnectionInfo,
  to: PublicApi.ChannelRecipient,
): boolean {
  const ref = info.ref();
  switch (to.__livething) {
    case 'connection-ref':
      return ref.instance === to.instance && info.id === to.id;

    case 'user-ref':
      return ref.instance === to.instance && info.userId !== '' && info.userId === to.id;

    case 'tag-ref':
      return info.tags.some((t) => t.kind === to.kind && t.group === to.group && t.key === to.key);

    case 'group-handle':
      return info.tags.some((t) => t.kind === to.kind && t.group === to.group);
  }
}

/** Attach a `broadcastRequest` arm to a tag group/ref handle. */
function addTagBroadcastRequest(handle: MemberHandle, runtime: BroadcastSender): void {
  handle.broadcastRequest = (event: string, payload: unknown, options?: RequestOptions) =>
    runtime.sendBroadcastRequest({
      targets: membersToTargets(handle.connections()),
      event,
      payload,
      options,
    });
}

/**
 * Build the per-engine pending map and the `sendServerRequest` helper every
 * server→client request surface (`ctx.request`, `ctx.connections.get(ref).request`,
 * `ctx.channel.request`) shares. The map lives here, in the requests capability,
 * so the engine core never imports it.
 */
function createOutgoingRequestRuntime(
  engine: EngineAccess,
  serverRequests: ReadonlyMap<string, ResolvedServerRequest>,
) {
  const pending = new Map<string, PendingServerRequest>();

  function settle(connectionId: string, frame: SettleFrameParameter): boolean {
    const correlationId = frame.livething?.correlationId;
    if (correlationId === undefined) return false;

    const entry = pending.get(correlationId);
    if (!entry) return false;

    if (entry.kind === 'broadcast')
      return settleBroadcastLeg({ connectionId, correlationId, entry, frame });

    // Only the connection that was asked may answer. A frame from any other
    // connection that happens to echo this correlationId is claimed (so it never
    // routes on as a normal event) but ignored — the real target stays pending.
    if (entry.connectionId !== connectionId) return true;

    // A second answer to the same id (or an answer to a request that already
    // timed out / dropped) finds no live entry above and falls through.
    pending.delete(correlationId);
    clearTimeout(entry.timer);

    if (frame.event === '__error__') {
      // The client could not answer (no handler, handler threw). Reject the
      // server promise with the typed error frame the client sent back.
      entry.reject(toRejection(frame.payload));
      return true;
    }

    if (entry.responseValidator) {
      try {
        entry.resolve(validateValue(entry.responseValidator, frame.payload, entry.event));
      } catch {
        entry.reject(RequestInvalidResponse({ event: entry.event, issues: [] }));
      }

      return true;
    }

    entry.resolve(undefined);

    return true;
  }

  /**
   * One leg of a broadcast answered. Silence and invalid answers both mean "no"
   * (drop the leg, keep waiting); the first VALID answer wins the whole race and
   * cancels every sibling leg. We always return `true` because the
   * correlationId matched a leg we own — even an invalid answer must not fall
   * through to normal routing.
   */
  function settleBroadcastLeg(args: SettleBroadcastLegArgsParameter): boolean {
    const { connectionId, correlationId, entry, frame } = args;
    // Only the leg's own target may answer it; a mismatched connection echoing
    // the leg's correlationId is claimed but ignored, leaving the leg live.
    if (entry.connectionId !== connectionId) return true;

    const { group } = entry;
    pending.delete(correlationId);
    group.legs.delete(correlationId);

    if (group.settled) return true;

    // A client that declined to answer sends `__error__`; treat it as silence.
    if (frame.event !== '__error__') {
      let response: unknown;
      let valid = true;
      if (group.responseValidator) {
        try {
          response = validateValue(group.responseValidator, frame.payload, group.event);
        } catch {
          valid = false;
        }
      } else {
        response = undefined;
      }

      if (valid) {
        finishBroadcast(group, () => group.resolve({ response, from: entry.from }));
        return true;
      }
    }

    // Invalid or a decline: this leg is out. If it was the last live leg, the
    // timer is what eventually rejects with Timeout (silence = nobody answered).
    return true;
  }

  /** Resolve/reject a broadcast once, cancelling its timer and every live leg. */
  function finishBroadcast(group: BroadcastGroup, settle: () => void): void {
    if (group.settled) return;

    group.settled = true;
    clearTimeout(group.timer);
    for (const legId of group.legs) pending.delete(legId);
    group.legs.clear();

    settle();
  }

  function rejectForConnection(connectionId: string): void {
    for (const [correlationId, entry] of pending) {
      if (entry.connectionId !== connectionId) continue;

      if (entry.kind === 'broadcast') {
        // One target dropping does NOT fail the broadcast — others may still
        // answer. Just retire this leg; the timer rejects only if all go quiet.
        pending.delete(correlationId);
        entry.group.legs.delete(correlationId);
        continue;
      }

      pending.delete(correlationId);
      clearTimeout(entry.timer);
      entry.reject(Disconnected());
    }
  }

  function sendRequest(args: SendRequestArgsParameter): Promise<unknown> {
    const { target, event, payload, options } = args;
    const declarationKey = serverRequestKey(target.declarationChannelKey ?? null, event);
    if (!serverRequests.has(declarationKey)) {
      return Promise.reject(RequestNotDeclared(event));
    }

    const declaration = serverRequests.get(declarationKey)!;

    const correlationId = engine.generateId('sreq');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(correlationId);
        reject(Timeout());
      }, options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);

      pending.set(correlationId, {
        kind: 'targeted',
        resolve,
        reject,
        timer,
        connectionId: target.connectionId,
        event,
        responseValidator: declaration?.responseValidator,
      });

      const sent = engine.sendServerRequest(target.connectionId, {
        event,
        payload,
        correlationId,
        channel: target.channel,
        channelFamily: target.channelFamily,
      });
      if (!sent) {
        // No live socket for this connection — fail fast instead of waiting out
        // the timeout for an answer that can never come.
        pending.delete(correlationId);
        clearTimeout(timer);
        reject(Disconnected());
      }
    });
  }

  /**
   * Fan a broadcast request out to every local target and race their answers.
   * Resolves with `{ response, from }` on the first VALID answer; rejects with
   * `Timeout` when no valid answer arrives in time — including the zero-target
   * case (nobody to ask = nobody volunteered). The caller resolves the targets
   * with the same enumeration the matching `broadcast`/tag broadcast uses.
   */
  function sendBroadcastRequest(
    args: SendBroadcastRequestArgsParameter,
  ): Promise<{ response: unknown; from: PublicApi.ConnectionRef }> {
    const { targets, event, payload, options, routing } = args;
    const declarationKey = serverRequestKey(args.declarationChannelKey ?? null, event);
    if (!serverRequests.has(declarationKey)) {
      return Promise.reject(RequestNotDeclared(event));
    }

    const declaration = serverRequests.get(declarationKey)!;

    return new Promise((resolve, reject) => {
      const group: BroadcastGroup = {
        resolve,
        reject,
        event,
        responseValidator: declaration?.responseValidator,
        legs: new Set<string>(),
        settled: false,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };

      group.timer = setTimeout(() => {
        finishBroadcast(group, () => group.reject(Timeout()));
      }, options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);

      for (const target of targets) {
        const correlationId = engine.generateId('breq');
        const sent = engine.sendServerRequest(target.connectionId, {
          event,
          payload,
          correlationId,
          channel: routing?.channel,
          channelFamily: routing?.channelFamily,
        });
        // A target whose socket is already gone simply contributes no leg —
        // others may still answer; if none remain the timer rejects.
        if (!sent) continue;

        group.legs.add(correlationId);
        pending.set(correlationId, {
          kind: 'broadcast',
          connectionId: target.connectionId,
          from: target.from,
          group,
        });
      }
    });
  }

  return { settle, rejectForConnection, sendRequest, sendBroadcastRequest };
}

/** Coerce a client `__error__` payload into a throwable for the server promise. */
function toRejection(payload: unknown): unknown {
  const code =
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { code?: unknown }).code === 'string'
      ? (payload as { code: string }).code
      : 'request-no-response';
  const detail =
    payload && typeof payload === 'object' ? (payload as { detail?: unknown }).detail : undefined;
  // Construct the error directly rather than through the public `error()`
  // factory: a client legitimately declines with a framework-reserved code
  // (e.g. `request-no-response`), which `error()` refuses — and that throw would
  // otherwise escape settle and leave the pending request to hang.
  return new LiveThingError(code as string, detail);
}

/**
 * The runtime primitive the `serverRequests({...})` capability contributes. Its
 * `__setup` installs the server→client request surfaces (`ctx.request`,
 * `ctx.connections.get(ref).request`, `ctx.channel.request`) and the inbound
 * answer-frame + disconnect seams. Channel-owned request verbs stay off
 * subscribe-gate contexts because those callbacks cannot infer the channel's
 * own request declaration map. The pending-request map lives in this module,
 * so the engine core never imports any of it (tree-shaking: a server without
 * `serverRequests()` pulls none of this).
 */
export function makeServerRequestsPrimitive(
  serverRequests: ReadonlyMap<string, ResolvedServerRequest>,
): Primitive {
  return {
    __livething: 'server-requests',
    __kind: 'infrastructure',
    __identity: [SERVER_REQUESTS_KEY],
    __requires: {},
    __serverRequests: serverRequests,
    __withServerRequests(next: ReadonlyMap<string, ResolvedServerRequest>): Primitive {
      return makeServerRequestsPrimitive(next);
    },
    __setup(engine: EngineAccess): void {
      const runtime = createOutgoingRequestRuntime(engine, serverRequests);

      engine.onAnswerFrame((connectionId, frame) => runtime.settle(connectionId, frame));

      engine.onDisconnect((ctx) => {
        const connectionId = (ctx as { connection?: { id?: string } }).connection?.id;
        if (connectionId) runtime.rejectForConnection(connectionId);
      });

      engine.extendContext((baseCtx) => {
        const ctx = baseCtx as Record<PropertyKey, unknown> & {
          connection?: PublicApi.ConnectionRef;
          connections?: { get?(ref: PublicApi.ConnectionRef): PublicApi.ConnectionHandle };
          user?: PublicApi.UserHandle & Record<string, unknown>;
          users?: { get?(id: string): PublicApi.UserHandle & Record<string, unknown> };
          channel?: PublicApi.ChannelHandle;
        };

        const connectionId = ctx.connection?.id;

        const extra: Record<string, unknown> = {};

        // ctx.request — ask the current connection. Inside a channel handler it
        // stamps the channel family so the answer routes back through it.
        if (connectionId) {
          extra.request = (event: string, payload: unknown, options?: RequestOptions) =>
            runtime.sendRequest({
              target: {
                connectionId,
                declarationChannelKey: null,
              },
              event,
              payload,
              options,
            });
        }

        // ctx.connections.get(ref).request — ask one specific connection by ref.
        const connections = ctx.connections;
        if (connections && typeof connections.get === 'function') {
          const coreGet = connections.get.bind(connections);
          connections.get = (ref: PublicApi.ConnectionRef) => {
            const handle = coreGet(ref) as PublicApi.ConnectionHandle & Record<string, unknown>;
            handle.request = (event: string, payload: unknown, options?: RequestOptions) => {
              assertLocalRef(ref, ctx.connection?.instance, 'ctx.connections.get(ref).request');
              return runtime.sendRequest({
                target: { connectionId: ref.id, declarationChannelKey: null },
                event,
                payload,
                options,
              });
            };
            return handle;
          };
        }

        // ctx.user.request / ctx.users.get(id).request — ask every live socket the
        // user holds and settle on the first valid answer.
        function attachUserRequest(handle: PublicApi.UserHandle & Record<string, unknown>) {
          handle.request = (event: string, payload: unknown, options?: RequestOptions) =>
            runtime.sendBroadcastRequest({
              targets: membersToTargets(handle.connections(), undefined),
              event,
              payload,
              options,
              declarationChannelKey: null,
            });
        }

        if (ctx.user) attachUserRequest(ctx.user);
        const users = ctx.users;
        if (users && typeof users.get === 'function') {
          const coreUsersGet = users.get.bind(users);
          users.get = (id: string) => {
            const handle = coreUsersGet(id);
            attachUserRequest(handle);
            return handle;
          };
        }

        // ctx.channel.request / ctx.channel.broadcastRequest — ask the current
        // connection (targeted) or fan out to every member (broadcast), each
        // stamping the channel family so answers route back through it.
        const channelHandle = ctx.channel as
          | (PublicApi.ChannelHandle & Record<string, unknown>)
          | undefined;
        const channelScope = ctx[ENGINE_CHANNEL_META] as { isSubscribeGate?: boolean } | undefined;

        // Channel request declarations live on the channel config object. The
        // check/commit/revalidate callbacks are contextualized before that
        // object has finished inferring its declarations, so their gate ctx
        // must not receive request methods that its public type cannot name.
        if (channelHandle && connectionId && !channelScope?.isSubscribeGate) {
          channelHandle.request = (
            event: string,
            payload: unknown,
            options?: RequestOptions & { to?: PublicApi.ChannelRecipient },
          ) => {
            const routing = {
              channel: channelHandle.name,
              channelFamily: channelHandle.family ?? null,
            };

            const declarationChannelKey = channelDeclarationKey(channelHandle);

            // A `to` recipient asks matching members instead of the caller. When
            // it resolves to more than one member the first valid answer wins;
            // `from` is dropped so the resolved type stays the bare response.
            const to = options?.to;
            if (to) {
              if (to.__livething === 'connection-ref' || to.__livething === 'user-ref') {
                assertLocalRef(to, ctx.connection?.instance, 'ctx.channel.request({ to })');
              }

              return runtime
                .sendBroadcastRequest({
                  targets: membersToTargets(
                    channelHandle.members().filter((member) => infoMatchesRecipient(member, to)),
                  ),
                  event,
                  payload,
                  options,
                  routing,
                  declarationChannelKey,
                })
                .then((winner) => winner.response);
            }

            return runtime.sendRequest({
              target: { connectionId, ...routing, declarationChannelKey },
              event,
              payload,
              options,
            });
          };
        }

        if (channelHandle && !channelScope?.isSubscribeGate) {
          channelHandle.broadcastRequest = (
            event: string,
            payload: unknown,
            options?: BroadcastRequestOptions,
          ) =>
            runtime.sendBroadcastRequest({
              // Exclude the calling connection by default, matching
              // ctx.channel.broadcast and ctx.broadcastRequest; an author can
              // opt back in with { includeSelf: true }. With no current
              // connection there is no self to drop.
              targets: membersToTargets(
                channelHandle.members(),
                (options?.includeSelf ?? false) ? undefined : connectionId,
              ),
              event,
              payload,
              options,
              routing: { channel: channelHandle.name, channelFamily: channelHandle.family ?? null },
              declarationChannelKey: channelDeclarationKey(channelHandle),
            });
        }

        // ctx.broadcastRequest — ask every other connection on this instance,
        // first valid answer wins. Self is excluded, mirroring ctx.broadcast.
        const allConnections = (ctx as { connections?: { all?(): PublicApi.ConnectionInfo[] } })
          .connections?.all;
        if (typeof allConnections === 'function') {
          extra.broadcastRequest = (
            event: string,
            payload: unknown,
            options?: BroadcastRequestOptions,
          ) =>
            runtime.sendBroadcastRequest({
              targets: membersToTargets(
                allConnections(),
                (options?.includeSelf ?? false) ? undefined : connectionId,
              ),
              event,
              payload,
              options,
              declarationChannelKey: null,
            });
        }

        // ctx.channels.get(...).broadcastRequest — fan a channel broadcast request
        // out to a named channel's members from any handler. It resolves the
        // CHANNEL's own request declarations (keyed by the channel's family or static
        // name), matching the active ctx.channel handle. The channel handle has no
        // current connection, so only the broadcast verb is added.
        const channelsApi = ctx.channels as
          | { get(...args: unknown[]): PublicApi.ChannelHandle & Record<string, unknown> }
          | undefined;
        if (channelsApi && typeof channelsApi.get === 'function') {
          const coreGet = channelsApi.get.bind(channelsApi);
          channelsApi.get = (...args: unknown[]) => {
            const handle = coreGet(...args);
            handle.broadcastRequest = (event: string, payload: unknown, options?: RequestOptions) =>
              runtime.sendBroadcastRequest({
                targets: membersToTargets(handle.members()),
                event,
                payload,
                options,
                routing: { channel: handle.name, channelFamily: handle.family ?? null },
                declarationChannelKey: handle.family ?? handle.name,
              });
            return handle;
          };
        }

        // ctx.tags.<kind>(group).broadcastRequest and .ref(key).broadcastRequest
        // — fan out to a tag group or one tag key, first valid answer wins.
        const tagsApi = ctx.tags as Record<string, unknown> | undefined;
        if (tagsApi) {
          for (const kind of ['ephemeral', 'persistent'] as const) {
            const coreFn = tagsApi[kind];
            if (typeof coreFn !== 'function') continue;

            tagsApi[kind] = (group: string) => {
              const handle = (coreFn as (g: string) => MemberHandle).call(
                tagsApi,
                group,
              ) as MemberHandle & { ref(key: string): MemberHandle };

              addTagBroadcastRequest(handle, runtime);

              const coreRef = handle.ref.bind(handle);

              handle.ref = (key: string) => {
                const refHandle = coreRef(key);
                addTagBroadcastRequest(refHandle, runtime);
                return refHandle;
              };

              return handle;
            };
          }
        }

        return extra;
      });
    },
  } as unknown as Primitive;
}

/** @internal Identity of the server-requests install primitive. */
const SERVER_REQUESTS_KEY = Symbol('server-requests');
