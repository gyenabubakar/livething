/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  Disconnected,
  LiveThingError,
  NotAMember,
  RequestInvalidResponse,
  Timeout,
} from '@livething/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import { ENGINE_CHANNEL_META } from '~/_engine/contexts/contexts.ts';
import { assertLocalRef } from '~/_engine/runtime/refs.ts';
import { assertTimerDelay } from '~/_engine/validation.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as PublicApi from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { ResolvedServerRequest } from '~/request/server-requests.ts';
import type { Validator } from '~/types.ts';

type ValueParameter = { response: unknown; from: PublicApi.ConnectionRef };
type ChannelDeclarationKeyHandleParameter = { name?: string; family?: unknown };
type SettleFrameParameter = {
  event: string;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
};
type SettleRaceLegArgsParameter = {
  connectionId: string;
  correlationId: string;
  entry: Extract<PendingServerRequest, { kind: 'race' }>;
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
type SendUserRequestArgsParameter = {
  user: PublicApi.UserHandle;
  event: string;
  payload: unknown;
  options: RequestOptions | undefined;
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
 * correlationId. A `targeted` entry is one request to one connection; a `race`
 * entry is one leg of a user request sent to each of the user's sockets — the
 * legs share a single `group` so the first valid answer wins and the rest are
 * dropped.
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
      kind: 'race';
      connectionId: string;
      /** The connection ref of this leg's target, returned as `from` when it wins. */
      from: PublicApi.ConnectionRef;
      /** The shared race state every leg of this request points at. */
      group: RaceGroup;
    };

/** The shared race state for one user request. */
interface RaceGroup {
  resolve: (value: ValueParameter) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
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

/**
 * Build the per-engine pending map and the send helpers every server→client
 * request surface (`ctx.request`, `ctx.connections.get(ref).request`,
 * `ctx.channel.request`, user requests) shares. The map lives here, in the
 * requests capability, so the engine core never imports it.
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

    if (entry.kind === 'race') return settleRaceLeg({ connectionId, correlationId, entry, frame });

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
   * One leg of a user request answered. Silence and invalid answers both mean
   * "no" (drop the leg, keep waiting); the first VALID answer wins the whole
   * race and cancels every sibling leg. We always return `true` because the
   * correlationId matched a leg we own — even an invalid answer must not fall
   * through to normal routing.
   */
  function settleRaceLeg(args: SettleRaceLegArgsParameter): boolean {
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
        finishRace(group, () => group.resolve({ response, from: entry.from }));
        return true;
      }
    }

    // Invalid or a decline: this leg is out. If it was the last live leg, the
    // timer is what eventually rejects with Timeout (silence = nobody answered).
    return true;
  }

  /** Resolve/reject a race once, cancelling its timer and every live leg. */
  function finishRace(group: RaceGroup, finish: () => void): void {
    if (group.settled) return;

    group.settled = true;
    clearTimeout(group.timer);
    for (const legId of group.legs) pending.delete(legId);
    group.legs.clear();

    finish();
  }

  function rejectForConnection(connectionId: string): void {
    for (const [correlationId, entry] of pending) {
      if (entry.connectionId !== connectionId) continue;

      if (entry.kind === 'race') {
        // One socket dropping does NOT fail the race — the user's other sockets
        // may still answer. Just retire this leg; the timer rejects only if all
        // go quiet.
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
      const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
      assertTimerDelay(timeout, 'timeout', `ctx.request("${event}", ...)`);

      const timer = setTimeout(() => {
        pending.delete(correlationId);
        reject(Timeout());
      }, timeout);

      pending.set(correlationId, {
        kind: 'targeted',
        resolve,
        reject,
        timer,
        connectionId: target.connectionId,
        event,
        responseValidator: declaration?.responseValidator,
      });

      let sent: boolean;
      try {
        sent = engine.sendServerRequest(target.connectionId, {
          event,
          payload,
          correlationId,
          channel: target.channel,
          channelFamily: target.channelFamily,
        });
      } catch (error) {
        // A payload that cannot be sent: no answer can come, so nothing is left waiting.
        pending.delete(correlationId);
        clearTimeout(timer);
        reject(error);
        return;
      }

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
   * Ask every live socket one user holds and race their answers. Resolves with
   * `{ response, from }` on the first VALID answer; rejects with `Timeout` when
   * no valid answer arrives in time — including when the user has no live
   * socket on this instance.
   */
  function sendUserRequest(
    args: SendUserRequestArgsParameter,
  ): Promise<{ response: unknown; from: PublicApi.ConnectionRef }> {
    const { user, event, payload, options } = args;
    const declarationKey = serverRequestKey(null, event);
    if (!serverRequests.has(declarationKey)) {
      return Promise.reject(RequestNotDeclared(event));
    }

    const declaration = serverRequests.get(declarationKey)!;

    return new Promise((resolve, reject) => {
      const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
      assertTimerDelay(timeout, 'timeout', `ctx.users.get(id).request("${event}", ...)`);

      const group: RaceGroup = {
        resolve,
        reject,
        event,
        responseValidator: declaration?.responseValidator,
        legs: new Set<string>(),
        settled: false,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };

      group.timer = setTimeout(() => {
        finishRace(group, () => group.reject(Timeout()));
      }, timeout);

      let fanOut: ReturnType<EngineAccess['openServerRequestBroadcast']>;
      try {
        fanOut = engine.openServerRequestBroadcast({
          event,
          payload,
          target: { kind: 'user', id: user.id },
        });
      } catch (error) {
        // Every socket gets the same payload, so none of them can be sent.
        finishRace(group, () => group.reject(error));
        return;
      }

      for (const connection of user.connections()) {
        const correlationId = engine.generateId('ureq');
        let sent: boolean;
        try {
          sent = fanOut.send(connection.id, correlationId);
        } catch (error) {
          fanOut.finish();
          finishRace(group, () => group.reject(error));
          return;
        }

        // A socket that is already gone simply contributes no leg — others may
        // still answer; if none remain the timer rejects.
        if (!sent) continue;

        group.legs.add(correlationId);
        pending.set(correlationId, {
          kind: 'race',
          connectionId: connection.id,
          from: connection.ref(),
          group,
        });
      }

      fanOut.finish();
    });
  }

  return { settle, rejectForConnection, sendRequest, sendUserRequest };
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
 * `ctx.connections.get(ref).request`, `ctx.channel.request`, user requests) and
 * the inbound answer-frame + disconnect seams. Channel-owned request verbs stay
 * off subscribe-gate contexts because those callbacks cannot infer the channel's
 * own request declaration map. The pending-request map lives in this module,
 * so the engine core never imports any of it (tree-shaking: a server without
 * `serverRequests()` pulls none of this).
 */
export function makeServerRequestsPrimitive(
  serverRequests: ReadonlyMap<string, ResolvedServerRequest>,
): Primitive {
  return {
    __livething: 'server-requests',
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

        // ctx.request — ask the current connection.
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
            runtime.sendUserRequest({ user: handle, event, payload, options });
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

        // ctx.channel.request — ask the current connection, or one other member
        // with `{ to }`, stamping the channel family so the answer routes back
        // through it.
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
            options?: RequestOptions & { to?: PublicApi.ConnectionRef },
          ) => {
            const to = options?.to;
            if (to) {
              assertLocalRef(to, ctx.connection?.instance, 'ctx.channel.request({ to })');
              // Only a member of this channel can answer through it.
              if (
                !engine.isConnectionInChannel(
                  to.id,
                  channelHandle.name,
                  channelHandle.family ?? null,
                )
              ) {
                return Promise.reject(NotAMember());
              }
            }

            return runtime.sendRequest({
              target: {
                connectionId: to?.id ?? connectionId,
                channel: channelHandle.name,
                channelFamily: channelHandle.family ?? null,
                declarationChannelKey: channelDeclarationKey(channelHandle),
              },
              event,
              payload,
              options,
            });
          };
        }

        return extra;
      });
    },
  } as unknown as Primitive;
}

/** @internal Identity of the server-requests install primitive. */
const SERVER_REQUESTS_KEY = Symbol('server-requests');
