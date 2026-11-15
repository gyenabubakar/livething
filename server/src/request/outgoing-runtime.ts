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
import { isBinaryPayload } from '~/outgoing/binary-payload.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as PublicApi from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { ResolvedServerRequest } from '~/request/server-requests.ts';
import type { Validator } from '~/types.ts';

/** What a user request resolves to: `{ response, from }`, or `{ info, bytes, from }` for a binary one. */
type ValueParameter =
  | { response: unknown; from: PublicApi.ConnectionRef }
  | { info: unknown; bytes: Uint8Array | undefined; from: PublicApi.ConnectionRef };
type ChannelDeclarationKeyHandleParameter = { name?: string; family?: unknown };
type SettleFrameParameter = {
  event: string;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
  /** The bytes of an answer that came as a binary frame. */
  bytes?: Uint8Array;
};
type SettleRaceLegArgsParameter = {
  connectionId: string;
  correlationId: string;
  entry: Extract<PendingServerRequest, { kind: 'race' }>;
  frame: SettleFrameParameter;
};

/** The kind of frame an answer must come as: the same kind as the request. */
type AnswerKind = 'text' | 'binary';

function answerKindOf(frame: SettleFrameParameter): AnswerKind {
  return frame.bytes === undefined ? 'text' : 'binary';
}

/** A text `__error__`: the client declines the request. A binary one is not a decline. */
function isDecline(frame: SettleFrameParameter): boolean {
  return frame.event === '__error__' && frame.bytes === undefined;
}

type SentRequestParameter = { event: string; payload: unknown };

/**
 * The declaration a request sends under, or the `request-not-declared` error. A binary
 * request's declaration must be binary, and a JSON request's must not be.
 */
function declarationFor(
  serverRequests: ReadonlyMap<string, ResolvedServerRequest>,
  key: string,
  request: SentRequestParameter,
): ResolvedServerRequest | LiveThingError {
  const { event, payload } = request;
  const declaration = serverRequests.get(key);
  if (!declaration) return RequestNotDeclared(event);

  const sentAsBinary = isBinaryPayload(payload);
  if ((declaration.binary === true) === sentAsBinary) return declaration;

  const error = RequestNotDeclared(event);
  error.message = sentAsBinary
    ? `[livething] '${event}' is declared in serverRequests({...}). ` +
      'Send it with .request(...), not .binary.request(...).'
    : `[livething] '${event}' is declared in binary({ serverRequests }). ` +
      'Send it with .binary.request(...), not .request(...).';

  return error;
}

/** The rejection for an answer of the wrong frame kind. */
function wrongKindAnswer(event: string, expected: AnswerKind): LiveThingError {
  return RequestInvalidResponse({
    event,
    issues: [{ message: `The answer must be a ${expected} frame.` }],
  });
}

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
      /** The frame kind the answer must come as. */
      answerKind: AnswerKind;
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
  /** The frame kind each answer must come as; an answer of the other kind is ignored. */
  answerKind: AnswerKind;
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

    // A text `__error__` declines a request of either kind: the client could not answer
    // (no handler, handler threw). Reject with the typed error the client sent back.
    if (isDecline(frame)) {
      entry.reject(toRejection(frame.payload));
      return true;
    }

    // The kind comes next, before any check of the answer: with no `in` schema, any answer
    // would count as success. A binary `__error__` is a wrong-kind answer, not a decline.
    if (answerKindOf(frame) !== entry.answerKind || frame.event === '__error__') {
      entry.reject(wrongKindAnswer(entry.event, entry.answerKind));
      return true;
    }

    let response: unknown;
    if (entry.responseValidator) {
      try {
        response = validateValue(entry.responseValidator, frame.payload, entry.event);
      } catch {
        entry.reject(RequestInvalidResponse({ event: entry.event, issues: [] }));
        return true;
      }
    }

    entry.resolve(
      entry.answerKind === 'binary' ? { info: response, bytes: frame.bytes } : response,
    );

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

    // A decline (`__error__`) is silence, and an answer of the wrong frame kind is ignored,
    // like an invalid one.
    if (frame.event !== '__error__' && answerKindOf(frame) === group.answerKind) {
      let response: unknown;
      let valid = true;
      if (group.responseValidator) {
        try {
          response = validateValue(group.responseValidator, frame.payload, group.event);
        } catch {
          valid = false;
        }
      }

      if (valid) {
        const answer =
          group.answerKind === 'binary'
            ? { info: response, bytes: frame.bytes, from: entry.from }
            : { response, from: entry.from };
        finishRace(group, () => group.resolve(answer));
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
    const declaration = declarationFor(serverRequests, declarationKey, { event, payload });
    if (declaration instanceof LiveThingError) return Promise.reject(declaration);

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
        responseValidator: declaration.responseValidator,
        answerKind: declaration.binary ? 'binary' : 'text',
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
  function sendUserRequest(args: SendUserRequestArgsParameter): Promise<ValueParameter> {
    const { user, event, payload, options } = args;
    const declaration = declarationFor(serverRequests, serverRequestKey(null, event), {
      event,
      payload,
    });
    if (declaration instanceof LiveThingError) return Promise.reject(declaration);

    return new Promise((resolve, reject) => {
      const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
      assertTimerDelay(timeout, 'timeout', `ctx.users.get(id).request("${event}", ...)`);

      const group: RaceGroup = {
        resolve,
        reject,
        event,
        responseValidator: declaration.responseValidator,
        answerKind: declaration.binary ? 'binary' : 'text',
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

  /** Whether a request sent to this connection waits for this correlation id. */
  function awaits(connectionId: string, correlationId: string): boolean {
    return pending.get(correlationId)?.connectionId === connectionId;
  }

  return { settle, awaits, rejectForConnection, sendRequest, sendUserRequest };
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
      engine.onAnswerAwaited((connectionId, correlationId) =>
        runtime.awaits(connectionId, correlationId),
      );

      engine.onDisconnect((ctx) => {
        const connectionId = (ctx as { connection?: { id?: string } }).connection?.id;
        if (connectionId) runtime.rejectForConnection(connectionId);
      });

      const wrapped = new WeakSet<object>();
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
        // A connection's contexts share one `connections` and one `users` manager, so each one
        // is wrapped once: wrapping it on every context build would stack one more layer per frame.
        const connections = ctx.connections;
        if (connections && typeof connections.get === 'function' && !wrapped.has(connections)) {
          wrapped.add(connections);
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
          // A binary request resolves `{ info, bytes, from }`: `ctx.user.binary.request` types it.
          handle.request = ((event: string, payload: unknown, options?: RequestOptions) =>
            runtime.sendUserRequest({
              user: handle,
              event,
              payload,
              options,
            })) as PublicApi.UserHandle['request'];
        }

        if (ctx.user) attachUserRequest(ctx.user);
        const users = ctx.users;
        if (users && typeof users.get === 'function' && !wrapped.has(users)) {
          wrapped.add(users);
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
