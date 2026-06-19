/* oxlint-disable @typescript-eslint/no-explicit-any */
import { error, RequestInvalidResponse, WSKitError } from '@wskit/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import { assertLocalRef } from '~/_engine/runtime/refs.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as PublicApi from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { ResolvedServerRequest } from '~/request/capability.ts';
import type { Validator } from '~/types.ts';

/**
 * Thrown into a `ctx.request(...)` promise when no answer arrives before the
 * timeout. Shares the `'timeout'` code family with the client-side `Timeout` so
 * a server author matches it the same way.
 */
const Timeout = /* @__PURE__ */ error('timeout');

/**
 * Thrown into a `ctx.request(...)` promise when the target connection drops
 * before it answers. Shares the `'disconnected'` code family with the
 * client-side `Disconnected`.
 */
const Disconnected = /* @__PURE__ */ error('disconnected');

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
  resolve: (value: { response: unknown; from: PublicApi.ConnectionRef }) => void;
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
  /** Exclude the calling connection from the fan-out (default true). */
  excludeSelf?: boolean;
}

/**
 * Compose the lookup key for one server→client request declaration. Keyed by
 * `[channelKey, event]` (channelKey is `null` for a top-level `requests({...})`
 * decl, or the channel's family key / static name for an `outgoing.requests`
 * decl), JSON-encoded so two channels can declare the same event name — and a
 * channel can reuse a top-level name — without clobbering each other. JSON keeps
 * the key unambiguous for any name without relying on a reserved separator.
 */
export function serverRequestKey(channelKey: string | null, event: string): string {
  return JSON.stringify([channelKey, event]);
}

/**
 * The channel-definition key for a runtime channel handle: its family key for a
 * dynamic channel, its static name otherwise — matching how `requests()` keys
 * the channel's own `outgoing.requests` decls. Top-level surfaces pass `null`.
 */
function channelDeclKey(handle: { name?: string; scope?: unknown }): string {
  return typeof handle.scope === 'string' ? handle.scope : (handle.name ?? '');
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
 * server→client request surface (`ctx.request`, `ctx.connection(ref).request`,
 * `ctx.channel.request`) shares. The map lives here, in the requests capability,
 * so the engine core never imports it.
 */
function createOutgoingRequestRuntime(
  engine: EngineAccess,
  serverRequests: ReadonlyMap<string, ResolvedServerRequest>,
) {
  const pending = new Map<string, PendingServerRequest>();

  function settle(
    connectionId: string,
    frame: {
      event: string;
      payload: unknown;
      wskit: Protocol.WSKitProtocol | undefined;
    },
  ): boolean {
    const correlationId = frame.wskit?.correlationId;
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

    entry.resolve(frame.payload);
    return true;
  }

  /**
   * One leg of a broadcast answered. Silence and invalid answers both mean "no"
   * (drop the leg, keep waiting); the first VALID answer wins the whole race and
   * cancels every sibling leg. We always return `true` because the
   * correlationId matched a leg we own — even an invalid answer must not fall
   * through to normal routing.
   */
  function settleBroadcastLeg(args: {
    connectionId: string;
    correlationId: string;
    entry: Extract<PendingServerRequest, { kind: 'broadcast' }>;
    frame: { event: string; payload: unknown };
  }): boolean {
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
        response = frame.payload;
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

  function sendRequest(args: {
    target: {
      connectionId: string;
      channel?: string;
      channelScope?: string | null;
      /** The channel definition key whose decls to resolve, or null for top-level. */
      declChannelKey?: string | null;
    };
    event: string;
    payload: unknown;
    options: RequestOptions | undefined;
  }): Promise<unknown> {
    const { target, event, payload, options } = args;
    const decl = serverRequests.get(serverRequestKey(target.declChannelKey ?? null, event));
    if (decl?.broadcast) {
      return Promise.reject(
        new Error(
          `[wskit] requests({ '${event}': { broadcast: true } }) is answerable only via broadcastRequest, not ctx.request.`,
        ),
      );
    }

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
        responseValidator: decl?.responseValidator,
      });

      const sent = engine.sendServerRequest(target.connectionId, {
        event,
        payload,
        correlationId,
        channel: target.channel,
        channelScope: target.channelScope,
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
   * with the same enumeration the matching `broadcast`/tag-send uses.
   */
  function sendBroadcastRequest(args: {
    targets: ReadonlyArray<{ connectionId: string; from: PublicApi.ConnectionRef }>;
    event: string;
    payload: unknown;
    options: RequestOptions | undefined;
    routing?: { channel?: string; channelScope?: string | null };
    /** The channel definition key whose decls to resolve, or null for top-level. */
    declChannelKey?: string | null;
  }): Promise<{ response: unknown; from: PublicApi.ConnectionRef }> {
    const { targets, event, payload, options, routing } = args;
    const decl = serverRequests.get(serverRequestKey(args.declChannelKey ?? null, event));
    if (!decl?.broadcast) {
      return Promise.reject(
        new Error(
          `[wskit] requests({ '${event}': ... }) is not declared { broadcast: true }, so it is answerable only via ctx.request, not broadcastRequest.`,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const group: BroadcastGroup = {
        resolve,
        reject,
        event,
        responseValidator: decl.responseValidator,
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
          channelScope: routing?.channelScope,
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
  return new WSKitError(code as string, detail);
}

/**
 * The runtime primitive the `requests({...})` capability contributes. Its
 * `__setup` installs the server→client request surfaces (`ctx.request`,
 * `ctx.connection(ref).request`, `ctx.channel.request`) and the inbound
 * answer-frame + disconnect seams. The pending-request map lives in this module,
 * so the engine core never imports any of it (tree-shaking: a server without
 * `requests()` pulls none of this).
 */
export function makeServerRequestsPrimitive(
  serverRequests: ReadonlyMap<string, ResolvedServerRequest>,
): Primitive {
  return {
    __wskit: 'server-requests',
    __kind: 'infrastructure',
    __identity: [SERVER_REQUESTS_KEY],
    __requires: {},
    __setup(engine: EngineAccess) {
      const runtime = createOutgoingRequestRuntime(engine, serverRequests);

      engine.onAnswerFrame((connectionId, frame) => runtime.settle(connectionId, frame));

      engine.onDisconnect((ctx) => {
        const connectionId = (ctx as { id?: string }).id;
        if (connectionId) runtime.rejectForConnection(connectionId);
      });

      engine.extendContext((baseCtx) => {
        const ctx = baseCtx as Record<PropertyKey, unknown> & {
          id?: string;
          connection?: (ref: PublicApi.ConnectionRef) => PublicApi.ConnectionHandle;
          channel?: PublicApi.ChannelHandle;
        };
        const connectionId = ctx.id;
        const scope =
          (ctx[ENGINE_SCOPE_META] as
            | { channelName?: string; channelScope?: string | null }
            | undefined) ?? {};

        const extra: Record<string, unknown> = {};

        // ctx.request — ask the current connection. Inside a channel handler it
        // stamps the channel scope so the answer routes back through it.
        if (connectionId) {
          extra.request = (event: string, payload: unknown, options?: RequestOptions) =>
            runtime.sendRequest({
              target: {
                connectionId,
                channel: scope.channelName,
                channelScope: scope.channelScope,
                // ctx.request resolves the TOP-LEVEL requests({...}) decls even
                // inside a channel handler; the channel scope above is only for
                // routing the answer back. ctx.channel.request resolves the
                // channel's own decls.
                declChannelKey: null,
              },
              event,
              payload,
              options,
            });
        }

        // ctx.connection(ref).request — ask one specific connection by ref.
        const coreConnection = ctx.connection;
        if (typeof coreConnection === 'function') {
          extra.connection = (ref: PublicApi.ConnectionRef) => {
            const handle = coreConnection(ref) as PublicApi.ConnectionHandle &
              Record<string, unknown>;
            handle.request = (event: string, payload: unknown, options?: RequestOptions) => {
              const self = (ctx as { self?: PublicApi.ConnectionRef }).self;
              assertLocalRef(ref, self?.instance, 'ctx.connection(ref).request');
              return runtime.sendRequest({
                target: { connectionId: ref.id, declChannelKey: null },
                event,
                payload,
                options,
              });
            };
            return handle;
          };
        }

        // ctx.channel.request / ctx.channel.broadcastRequest — ask the current
        // connection (targeted) or fan out to every member (broadcast), each
        // stamping the channel scope so answers route back through it.
        const channelHandle = ctx.channel as
          | (PublicApi.ChannelHandle & Record<string, unknown>)
          | undefined;
        if (channelHandle && connectionId) {
          channelHandle.request = (event: string, payload: unknown, options?: RequestOptions) =>
            runtime.sendRequest({
              target: {
                connectionId,
                channel: channelHandle.name,
                channelScope: channelHandle.scope ?? null,
                declChannelKey: channelDeclKey(channelHandle),
              },
              event,
              payload,
              options,
            });
        }
        if (channelHandle) {
          channelHandle.broadcastRequest = (
            event: string,
            payload: unknown,
            options?: BroadcastRequestOptions,
          ) =>
            runtime.sendBroadcastRequest({
              // Exclude the calling connection by default, matching
              // ctx.channel.broadcast and ctx.broadcastRequest; an author can
              // opt back in with { excludeSelf: false }. With no current
              // connection there is no self to drop.
              targets: membersToTargets(
                channelHandle.members(),
                (options?.excludeSelf ?? true) ? connectionId : undefined,
              ),
              event,
              payload,
              options,
              routing: { channel: channelHandle.name, channelScope: channelHandle.scope ?? null },
              declChannelKey: channelDeclKey(channelHandle),
            });
        }

        // ctx.broadcastRequest — ask every other connection on this instance,
        // first valid answer wins. Self is excluded, mirroring ctx.broadcast.
        const getConnections = (ctx as { getConnections?: () => PublicApi.ConnectionInfo[] })
          .getConnections;
        if (typeof getConnections === 'function') {
          extra.broadcastRequest = (
            event: string,
            payload: unknown,
            options?: BroadcastRequestOptions,
          ) =>
            runtime.sendBroadcastRequest({
              targets: membersToTargets(
                getConnections(),
                (options?.excludeSelf ?? true) ? connectionId : undefined,
              ),
              event,
              payload,
              options,
              declChannelKey: null,
            });
        }

        // ctx.channels.get(name).broadcastRequest — fan a TOP-LEVEL broadcast
        // request out to a named channel's members from any handler. A top-level
        // handler cannot see a channel's own request types, so this resolves the
        // top-level decls; only the active ctx.channel handle resolves a channel's
        // own decls. The channel handle has no current connection, so only the
        // broadcast verb is added.
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
                routing: { channel: handle.name, channelScope: handle.scope ?? null },
                declChannelKey: null,
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
  };
}

/** @internal Identity of the server-requests install primitive. */
const SERVER_REQUESTS_KEY = Symbol('server-requests');
