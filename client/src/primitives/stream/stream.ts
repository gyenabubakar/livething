import { Disconnected, Timeout } from '~/errors.ts';
import { toLiveThingError, unscopeErrorCode } from '~/internal/error-frame.ts';
import { idGenerator } from '~/internal/id.ts';
import { namespacePrefixOf } from '~/internal/namespace.ts';
import { getAugmenters, scopedName } from '~/internal/scoped.ts';
import { isProtocolFrameEvent, wireIdError } from '~/internal/wire-validation.ts';
import { buildStreamHandle } from '~/primitives/stream/handle.ts';
import { StreamState } from '~/primitives/stream/state.ts';
import type { LiveThingError } from '@livething/core';
import type {
  FrameOwner,
  LiveThingMetadata,
  Message,
  PrimitiveLogger,
  SendResult,
} from '~/internal/runtime.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type { StreamHandleDependencies } from '~/primitives/stream/handle.ts';
import type {
  StreamOptions,
  StreamPrimitive,
  StreamTriggerOptions,
} from '~/primitives/stream/types.ts';
import type { StreamHandle, StreamHandlers } from '~/types.ts';

interface Trigger {
  resolve: (handle: StreamHandle<unknown>) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  event: string;
  markers: ScopeMarkers;
}

interface PendingNudge {
  streamId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface BroadcastSub {
  handlers: StreamHandlers<unknown>;
  scope: ScopeMarkers | undefined;
}

interface BroadcastRun {
  event: string;
  lastSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface StreamContext {
  markers: ScopeMarkers;
  options?: StreamTriggerOptions;
}

interface ContinueStreamOptions {
  lastKnownSeq?: number;
}

interface ContinueContext {
  markers: ScopeMarkers;
  options?: ContinueStreamOptions;
}

/** True if a chunk's scope markers match what an `onStream` subscriber asked for. */
function scopeMatches(
  scope: ScopeMarkers | undefined,
  envelope: LiveThingMetadata | null,
): boolean {
  if (!scope) return envelope?.channel === undefined;

  return scope.name === envelope?.channel?.name && scope.family === envelope?.channel?.family;
}

/** The `stream-aborted` reason on an error, if any. */
function abortReason(error: LiveThingError): string | undefined {
  return (error.detail as { reason?: string } | undefined)?.reason;
}

/** Run a broadcast-stream callback in isolation so one throw can't stop the rest. */
function callStreamHandler(log: PrimitiveLogger, run: () => void): void {
  try {
    run();
  } catch (error) {
    log.report(error);
  }
}

/**
 * Streaming / chunked messages. `socket.stream()` starts a stream and returns
 * an async iterable of chunks; `socket.onStream()` subscribes to server-pushed
 * broadcast streams. Chunks are matched by `streamId`, duplicates are dropped
 * by `seq`, and durable streams restart automatically on reconnect.
 *
 * Pair durable streams with `keepalive()` (and `reconnection()`): a durable
 * stream waits for the next chunk, so on a half-open connection — one that died
 * with no close frame — only keepalive's pings can notice and force a reconnect.
 * Without it the stream can wait indefinitely (in debug mode this warns).
 *
 * Start a stream while the socket is open or connecting. On a non-lazy socket
 * you have not `connect()`ed yet (state `closed`), `socket.stream()` rejects at
 * once with `disconnected` — a lazy socket connects on first use.
 */
export function stream(options: StreamOptions = {}): StreamPrimitive {
  const timeout = options.timeout ?? 30_000;
  const nudgeTimeout = options.nudgeTimeout ?? 10_000;
  // A reconnect can legitimately take longer than a single chunk gap (the server may
  // be replaying a buffer), so the continue deadline is more generous than the
  // per-chunk timeout. It only bounds the wait so a server that never continues
  // can't hang the iterator forever. Disabled when per-chunk timeouts are off.
  const continueDeadline = timeout <= 0 ? 0 : Math.max(timeout, 30_000);

  return {
    _tag: 'stream',
    // A channel-scoped continue frame requires channel membership to be set up
    // first (same as replaying missed messages). Run after channels when present.
    optionalAfter: ['channels'],
    setup(helpers) {
      const streams = new Map<string, StreamState>();
      const triggers = new Map<string, Trigger>();
      const broadcastSubs = new Map<string, Set<BroadcastSub>>();
      const broadcastRuns = new Map<string, BroadcastRun>();
      const pendingNudges = new Map<string, PendingNudge>();
      // Trigger frames for streams started before the socket was open with no
      // buffering installed to hold them, keyed by streamId. helpers.send drops
      // while not open, so they are held here and flushed on open — otherwise the
      // stream would never start (and with timeout 0 the promise would never
      // settle, leaking the lazy hold).
      const triggerOutbox = new Map<string, { message: Message; owner: FrameOwner }>();
      const continueOutbox = new Map<string, Message>();
      // Cancel frames for streams cancelled while the socket was connecting/
      // reconnecting (rawSend can't send them yet), keyed by streamId. Held here
      // and flushed on open; the stream stays alive until then so its durable row
      // isn't left orphaned server-side, and a pending cancel suppresses continue.
      const cancelOutbox = new Map<string, Message>();
      // Warn at most once: a durable stream relies on detecting a dead socket,
      // which only keepalive can do for a half-open connection (no close event).
      let warnedNoKeepalive = false;

      function startChunkTimer(state: StreamState): void {
        if (state.timer) clearTimeout(state.timer);
        if (timeout <= 0) return;

        state.timer = setTimeout(() => {
          helpers.log.info(`stream '${state.streamId}' timed out`);
          finishStream(state, Timeout());
        }, timeout);
      }

      // `error` undefined means a clean end (the loop exits); an error makes it throw.
      // The lazy hold is released through the idempotent helper, so finishing a
      // stream that already released its hold on a drop can't double-release.
      function finishStream(state: StreamState, error?: unknown): void {
        if (!state.active) return;

        state.active = false;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        if (state.continueTimer) clearTimeout(state.continueTimer);

        state.continueTimer = null;
        streams.delete(state.streamId);
        continueOutbox.delete(state.streamId);
        cancelOutbox.delete(state.streamId);
        releaseStreamHold(state);

        settleStreamNudges(state.streamId, error);

        if (error) state.queue.abort(error);
        else state.queue.end();
      }

      // A nudge still waiting for its answer when the stream finishes gets the
      // same result as a nudge sent after the end (success), or the error that
      // ended the stream.
      function settleStreamNudges(streamId: string, error?: unknown): void {
        for (const [id, pending] of pendingNudges) {
          if (pending.streamId !== streamId) continue;

          settleNudge(id, (nudge) => (error ? nudge.reject(error) : nudge.resolve()));
        }
      }

      // Idempotent per-stream lazy hold. A durable stream releases its hold on a
      // drop and re-acquires on reconnect; if several failed reconnect attempts each
      // fire onClose, only the first release counts, so the global lazy count can't
      // be corrupted for unrelated consumers.
      function acquireStreamHold(state: StreamState): void {
        if (state.hasLazyHold) return;

        state.hasLazyHold = true;
        helpers.lazyAcquire();
      }

      function releaseStreamHold(state: StreamState): void {
        if (!state.hasLazyHold) return;

        state.hasLazyHold = false;
        helpers.lazyRelease();
      }

      // Fail a pending trigger and tear it down once: clear its timer, drop it from
      // the trigger map and outbox, release the hold it took, then reject. Shared by
      // the timeout, a server error, a disconnect, and a buffered-frame owner.
      function failTrigger(streamId: string, error: unknown): void {
        const trigger = triggers.get(streamId);
        if (!trigger) return;

        if (trigger.timer) clearTimeout(trigger.timer);
        triggers.delete(streamId);
        triggerOutbox.delete(streamId);

        helpers.lazyRelease();
        trigger.reject(error);
      }

      function settleNudge(id: string | undefined, run: (pending: PendingNudge) => void): void {
        if (id === undefined) return;

        const pending = pendingNudges.get(id);
        if (!pending) return;

        if (pending.timer) clearTimeout(pending.timer);
        pendingNudges.delete(id);

        run(pending);
      }

      function continueFrame(state: StreamState, lastKnownSeq?: number): Message {
        const seq = lastKnownSeq ?? (Number.isFinite(state.lastSeq) ? state.lastSeq : undefined);
        return {
          event: '__continueStream__',
          payload: seq !== undefined ? { lastKnownSeq: seq } : {},
          metadata: {
            stream: { id: state.streamId },
            ...(state.markers.name
              ? {
                  channel: {
                    name: state.markers.name,
                    ...(state.markers.family ? { family: state.markers.family } : {}),
                  },
                }
              : {}),
          },
        };
      }

      const handleDependencies: StreamHandleDependencies = {
        nudge(state, details) {
          const { event, payload } = details;
          const eventError = wireIdError(event, event, 'event');
          if (eventError) return Promise.reject(eventError);

          const streamNudgeId = idGenerator(helpers)('nudge');
          let result: SendResult;

          try {
            result = helpers.rawSend({
              // A plugin stream's nudge event needs the same `__id::` prefix its
              // trigger carries (the server registers nudges under it); derive it
              // from the stream's own namespaced event. A plain app stream gets ''.
              event: namespacePrefixOf(state.event) + event,
              payload,
              metadata: {
                stream: { id: state.streamId, nudgeId: streamNudgeId },
                ...(state.markers.name
                  ? {
                      channel: {
                        name: state.markers.name,
                        ...(state.markers.family ? { family: state.markers.family } : {}),
                      },
                    }
                  : {}),
              },
            });
          } catch (error) {
            // Serialization happens inside rawSend, before the Promise exists —
            // turn a throw into a rejection so nudge() always returns a Promise.
            return Promise.reject(error);
          }

          // Not open: fail fast rather than drop the frame and wait out the timeout.
          if (result !== 'sent') return Promise.reject(Disconnected());

          const timeoutMs = details.timeout ?? nudgeTimeout;

          return new Promise<void>((resolve, reject) => {
            const timer =
              timeoutMs > 0
                ? setTimeout(() => {
                    pendingNudges.delete(streamNudgeId);
                    reject(Timeout());
                  }, timeoutMs)
                : null;
            pendingNudges.set(streamNudgeId, { streamId: state.streamId, resolve, reject, timer });
          });
        },
        cancel(state) {
          const frame: Message = {
            event: '__streamCancel__',
            payload: null,
            metadata: {
              stream: { id: state.streamId },
              ...(state.markers.name
                ? {
                    channel: {
                      name: state.markers.name,
                      ...(state.markers.family ? { family: state.markers.family } : {}),
                    },
                  }
                : {}),
            },
          };

          const result = helpers.rawSend(frame);
          // Connecting/reconnecting: hold the cancel and keep the stream alive so its
          // durable row isn't orphaned. It flushes (and the stream finishes) on open.
          if (result === 'connecting') {
            cancelOutbox.set(state.streamId, frame);
            return;
          }

          finishStream(state); // a cancel ends the loop without throwing
        },
      };

      function triggerStream(
        event: string,
        payload: unknown,
        context: StreamContext,
      ): Promise<StreamHandle<unknown>> {
        const streamId = context.options?.streamId ?? idGenerator(helpers)('stream');
        // Reject a bad event or streamId locally — the server rejects such a frame
        // before it can route the error back to settle this Promise.
        const idError =
          wireIdError(event, event, 'event') ?? wireIdError(event, streamId, 'streamId');
        if (idError) return Promise.reject(idError);

        helpers.ensureConnected();
        helpers.lazyAcquire();
        const frame: Message = {
          event,
          payload,
          metadata: {
            stream: { id: streamId },
            ...(context.markers.name
              ? {
                  channel: {
                    name: context.markers.name,
                    ...(context.markers.family ? { family: context.markers.family } : {}),
                  },
                }
              : {}),
          },
        };

        const owner: FrameOwner = {
          isPending: () => triggers.has(streamId),
          reject: (error) => failTrigger(streamId, error),
        };

        // Send through the normal path so buffering can take it — queued while
        // offline, or held behind a draining staggered flush so it keeps order. With
        // no buffering, hold it only while a connect is in progress (flushed on
        // open); on a closed socket nothing will flush it, so fail fast.
        let result: SendResult;
        try {
          result = helpers.send(frame, { owner });
        } catch (error) {
          helpers.lazyRelease(); // roll back the hold the trigger acquired above
          // Return a rejected Promise rather than throwing so socket.stream() never
          // throws synchronously — its contract is to always return a Promise.
          return Promise.reject(error);
        }

        if (result === 'connecting') {
          triggerOutbox.set(streamId, { message: frame, owner });
        } else if (result === 'closed' || result === 'blocked') {
          helpers.lazyRelease();
          return Promise.reject(Disconnected());
        }

        return new Promise<StreamHandle<unknown>>((resolve, reject) => {
          const timer =
            timeout > 0 ? setTimeout(() => failTrigger(streamId, Timeout()), timeout) : null;
          triggers.set(streamId, {
            resolve,
            reject,
            timer,
            event,
            markers: context.markers,
          });
        });
      }

      function continueStream(
        event: string,
        streamId: string,
        context: ContinueContext,
      ): StreamHandle<unknown> {
        const idError = wireIdError(event, streamId, 'streamId');
        if (idError) {
          // Can't continue an unroutable id — settle the handle instead of sending
          // a frame the server rejects before it can route the error back.
          const errored = new StreamState(streamId, event, context.markers);
          finishStream(errored, idError);
          return buildStreamHandle(errored, handleDependencies);
        }

        let state = streams.get(streamId);
        if (!state) {
          state = new StreamState(streamId, event, context.markers);
          state.durable = true;
          streams.set(streamId, state);
          acquireStreamHold(state);
        }

        startChunkTimer(state);

        const frame = continueFrame(state, context.options?.lastKnownSeq);
        let result: SendResult;
        try {
          result = helpers.rawSend(frame);
        } catch (error) {
          // A reconnect frame that can't serialize ends the stream with the error
          // (the queue buffers it for a late iterator) rather than throwing out of
          // continueStream — its contract is to always return a handle.
          finishStream(state, error);
          return buildStreamHandle(state, handleDependencies);
        }

        if (result === 'connecting') {
          continueOutbox.set(streamId, frame);
        } else if (result === 'closed') {
          // Closed, non-lazy: settle now; the queue buffers the abort for a late iterator.
          finishStream(state, Disconnected());
        }

        return buildStreamHandle(state, handleDependencies);
      }

      function subscribeBroadcast(
        event: string,
        handlers: StreamHandlers<unknown>,
        scope: ScopeMarkers | undefined,
      ): () => void {
        helpers.lazyAcquire();
        let subscribers = broadcastSubs.get(event);
        if (!subscribers) {
          subscribers = new Set();
          broadcastSubs.set(event, subscribers);
        }

        const subscriber: BroadcastSub = { handlers, scope };
        subscribers.add(subscriber);
        // Guard so calling this unsubscribe more than once releases the lazy hold
        // only once — a second call must not steal another listener's hold.
        let released = false;

        return () => {
          if (released) return;

          released = true;
          subscribers.delete(subscriber);
          if (subscribers.size === 0) broadcastSubs.delete(event);
          helpers.lazyRelease();
        };
      }

      function deliverBroadcast(message: Message, streamId: string): void {
        const { event, payload } = message;
        const envelope = message.metadata;
        const seq = envelope?.stream?.seq;
        const subscribers = broadcastSubs.get(event);
        if (!subscribers || subscribers.size === 0) return;

        const recipients = [...subscribers].filter((subscriber) =>
          scopeMatches(subscriber.scope, envelope ?? null),
        );
        if (recipients.length === 0) return;

        let run = broadcastRuns.get(streamId);
        if (!run) {
          run = { event, lastSeq: Number.NEGATIVE_INFINITY, timer: null };
          broadcastRuns.set(streamId, run);
        }

        if (seq !== undefined && seq <= run.lastSeq) return;

        if (seq !== undefined) run.lastSeq = seq;
        if (run.timer) clearTimeout(run.timer);
        if (timeout > 0) {
          run.timer = setTimeout(() => {
            helpers.log.info(`broadcast stream '${streamId}' timed out`);
            broadcastRuns.delete(streamId);
            for (const subscriber of broadcastSubs.get(event) ?? [])
              if (scopeMatches(subscriber.scope, envelope ?? null))
                callStreamHandler(helpers.log, () => subscriber.handlers.onTimeout?.(streamId));
          }, timeout);
        }

        helpers.log.info(`broadcast stream '${streamId}' chunk received`);
        for (const subscriber of recipients)
          callStreamHandler(helpers.log, () => subscriber.handlers.onChunk(payload, streamId));
      }

      function endBroadcast(
        streamId: string,
        envelope: LiveThingMetadata | null,
        notify: (handlers: StreamHandlers<unknown>) => void,
      ): void {
        const active = broadcastRuns.get(streamId);
        if (active?.timer) clearTimeout(active.timer);
        broadcastRuns.delete(streamId);

        // Route only to subscribers of this stream's event (from a live run, or the
        // eventName the server stamps on broadcast terminal frames). A frame whose
        // event can't be resolved — e.g. a private stream's end, which has neither —
        // is left alone; fanning out to every subscriber would misdeliver it.
        const event = active?.event ?? envelope?.stream?.event;
        if (event === undefined) return;

        for (const subscriber of broadcastSubs.get(event) ?? [])
          if (scopeMatches(subscriber.scope, envelope))
            callStreamHandler(helpers.log, () => notify(subscriber.handlers));
      }

      function handleStreamOk(streamId: string, envelope: LiveThingMetadata | null): null {
        const trigger = triggers.get(streamId);
        if (!trigger) {
          const continued = streams.get(streamId);
          if (continued?.continueTimer) {
            clearTimeout(continued.continueTimer);
            continued.continueTimer = null;
          }

          return null;
        }

        if (trigger.timer) clearTimeout(trigger.timer);
        triggers.delete(streamId);
        triggerOutbox.delete(streamId);

        const state = new StreamState(streamId, trigger.event, trigger.markers);
        state.hasLazyHold = true;
        state.durable = envelope?.stream?.durability === 'persistent';
        if (state.durable && !warnedNoKeepalive && !helpers.hasPrimitive('keepalive')) {
          warnedNoKeepalive = true;
          helpers.log.warn(
            'a durable stream is active without keepalive() — if the connection half-dies (no close frame) the stream cannot tell and will wait forever. Add keepalive() so a dead connection is detected and the stream continues.',
          );
        }

        streams.set(streamId, state);

        startChunkTimer(state);
        trigger.resolve(buildStreamHandle(state, handleDependencies));

        return null;
      }

      function handleStreamError(
        message: Message,
        streamId: string,
        envelope: LiveThingMetadata | null,
      ): Message | null {
        if (envelope?.exchange?.id !== undefined) return message;

        const streamEvent =
          triggers.get(streamId)?.event ??
          streams.get(streamId)?.event ??
          broadcastRuns.get(streamId)?.event ??
          envelope?.stream?.event;
        const error = unscopeErrorCode(
          streamEvent,
          toLiveThingError(message.payload),
        ) as LiveThingError;
        if (envelope?.stream?.terminated === false) {
          settleNudge(envelope.stream.nudgeId, (pending) => pending.reject(error));
          return null;
        }

        if (triggers.has(streamId)) {
          failTrigger(streamId, error);
          return null;
        }

        const state = streams.get(streamId);
        if (state) finishOrContinueAfterError(state, error);
        endBroadcast(streamId, envelope, (handlers) => handlers.onError?.(error, streamId));

        return null;
      }

      function finishOrContinueAfterError(state: StreamState, error: LiveThingError): void {
        if (
          state.durable &&
          error.code === 'stream-aborted' &&
          abortReason(error) === 'hibernation-wake'
        ) {
          startChunkTimer(state);
          helpers.rawSend(continueFrame(state));
          return;
        }

        finishStream(state, error);
      }

      function handleStreamChunk(
        message: Message,
        streamId: string,
        envelope: LiveThingMetadata | null,
      ): Message {
        if (isProtocolFrameEvent(message.event)) return message;

        const seq = envelope?.stream?.seq ?? envelope?.delivery?.seq;
        const state = streams.get(streamId);
        if (state && (seq === undefined || seq > state.lastSeq)) {
          if (state.continueTimer) {
            clearTimeout(state.continueTimer);
            state.continueTimer = null;
          }

          if (seq !== undefined) state.lastSeq = seq;
          if (helpers.log.debug) helpers.log.info(`stream '${streamId}' chunk received`);
          state.queue.push(message.payload);
          startChunkTimer(state);
        }

        deliverBroadcast(message, streamId);

        return message;
      }

      return {
        id: 'stream',

        onIncoming(message) {
          const envelope = message.metadata;
          const streamId = envelope?.stream?.id;
          if (typeof streamId !== 'string') return message;

          switch (message.event) {
            case '__streamOk__':
              return handleStreamOk(streamId, envelope ?? null);

            case '__streamEnd__': {
              helpers.log.info(`stream '${streamId}' completed`);
              const state = streams.get(streamId);
              if (state) finishStream(state);
              endBroadcast(streamId, envelope ?? null, (handlers) =>
                handlers.onEnd?.(streamId, envelope?.stream?.seq),
              );
              return null;
            }

            case '__nudgeOk__': {
              settleNudge(envelope?.stream?.nudgeId, (pending) => pending.resolve());
              return null;
            }

            case '__error__':
              return handleStreamError(message, streamId, envelope ?? null);

            default:
              return handleStreamChunk(message, streamId, envelope ?? null);
          }
        },

        onOpen() {
          // Flush held cancels first and finish those streams — a cancel queued
          // during reconnect must reach the server (deleting its durable row) and
          // wins over any continue.
          const cancelled = [...cancelOutbox.entries()];
          cancelOutbox.clear();
          for (const [streamId, frame] of cancelled) {
            helpers.rawSend(frame);
            const state = streams.get(streamId);
            if (state) finishStream(state);
          }

          // Flush trigger frames for streams started while the socket was still
          // connecting; rawSend would have dropped them before open. Each trigger
          // carries its owner so a frame that can't serialize rejects that exact
          // stream() Promise (and a later frame still flushes), and a trigger that
          // already settled is skipped.
          const triggerEntries = [...triggerOutbox.values()];
          triggerOutbox.clear();
          for (const { message, owner } of triggerEntries) {
            if (owner.isPending()) helpers.rawSend(message, owner);
          }

          if (continueOutbox.size === 0) return null;

          const frames = [...continueOutbox.values()];
          continueOutbox.clear();

          return frames;
        },

        onReconnect() {
          const frames: Message[] = [];
          for (const state of streams.values()) {
            // A queued cancel wins over continue — don't revive a stream the user
            // already asked to cancel; onOpen flushes the cancel instead.
            if (cancelOutbox.has(state.streamId)) continue;

            if (state.active && state.durable) {
              acquireStreamHold(state);
              frames.push(continueFrame(state));
              // Bound the reconnect: if no continued chunk arrives, the deadline ends
              // the stream rather than leaving it (and its lazy hold) hung. The
              // per-chunk timer is intentionally NOT started here — it begins only
              // when the first continued chunk lands.
              if (continueDeadline > 0) {
                if (state.continueTimer) clearTimeout(state.continueTimer);
                state.continueTimer = setTimeout(() => {
                  state.continueTimer = null;
                  finishStream(state, Timeout());
                }, continueDeadline);
              }
            }
          }

          return frames.length ? frames : null;
        },

        onClose(...args) {
          const [code, reason, intentional, suspended] = args;
          for (const trigger of triggers.values()) {
            if (trigger.timer) clearTimeout(trigger.timer);
            helpers.lazyRelease();
            trigger.reject(Disconnected());
          }

          triggers.clear();
          triggerOutbox.clear();
          continueOutbox.clear();

          for (const pending of pendingNudges.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(Disconnected());
          }

          pendingNudges.clear();

          for (const state of [...streams.values()]) {
            if (state.timer) clearTimeout(state.timer);
            state.timer = null;
            if (state.continueTimer) clearTimeout(state.continueTimer);
            state.continueTimer = null;
            // A durable stream survives an unexpected drop only if the socket can
            // actually reconnect; otherwise the reconnect that would revive its queue
            // never comes, so finish it (the for-await loop throws Disconnected
            // instead of hanging forever).
            if (
              state.durable &&
              !intentional &&
              (suspended || helpers.willReconnect(code, reason))
            ) {
              // Keep the stream for the reconnect window but release its hold. The
              // idempotent release means a second onClose (a failed first reconnect
              // attempt) can't double-release and corrupt the global lazy count.
              releaseStreamHold(state);
            } else {
              finishStream(state, Disconnected());
            }
          }

          for (const run of broadcastRuns.values()) {
            if (run.timer) clearTimeout(run.timer);
            run.timer = null;
          }

          // Keep each run's last seq across a drop that will reconnect: a reconnect
          // resends stored chunks, and onChunk must not see those twice.
          if (intentional || !(suspended || helpers.willReconnect(code, reason))) {
            broadcastRuns.clear();
          }
        },

        onReconnectFailed() {
          broadcastRuns.clear();
          for (const trigger of triggers.values()) {
            if (trigger.timer) clearTimeout(trigger.timer);
            helpers.lazyRelease();
            trigger.reject(Disconnected());
          }

          triggers.clear();
          triggerOutbox.clear();

          // Reconnection is abandoned — the reconnect that would revive a kept stream
          // never comes. finishStream releases the hold idempotently, so a stream
          // that already released on the drop won't release twice; the for-await
          // loop throws Disconnected instead of hanging forever.
          for (const state of [...streams.values()]) finishStream(state, Disconnected());
        },

        install(socket) {
          // @ts-expect-error — install adds stream() to the socket dynamically
          socket.stream = (
            event: string,
            payload: unknown,
            triggerOptions?: StreamTriggerOptions,
          ) => triggerStream(event, payload, { markers: {}, options: triggerOptions });
          // @ts-expect-error — install adds onStream() to the socket dynamically
          socket.onStream = (event: string, handlers: StreamHandlers<unknown>) =>
            subscribeBroadcast(event, handlers, undefined);
          // @ts-expect-error — install adds continueStream() to the socket dynamically
          socket.continueStream = (
            event: string,
            streamId: string,
            continueOptions?: ContinueStreamOptions,
          ) => continueStream(event, streamId, { markers: {}, options: continueOptions });

          getAugmenters(socket).push((messaging, scope) => {
            messaging.stream = (
              event: string,
              payload: unknown,
              triggerOptions?: StreamTriggerOptions,
            ) => {
              scope.assertReady?.();
              return triggerStream(scopedName(scope, event), payload, {
                markers: scope.markers(),
                options: triggerOptions,
              });
            };
            messaging.onStream = (event: string, handlers: StreamHandlers<unknown>) =>
              subscribeBroadcast(scopedName(scope, event), handlers, scope.markers());
            messaging.continueStream = (
              event: string,
              streamId: string,
              continueOptions?: ContinueStreamOptions,
            ) => {
              scope.assertReady?.();
              return continueStream(scopedName(scope, event), streamId, {
                markers: scope.markers(),
                options: continueOptions,
              });
            };
          });
        },
      };
    },
  };
}

stream.tag = 'stream';
