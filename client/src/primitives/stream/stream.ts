import { Disconnected, Timeout } from '~/errors.ts';
import { toWSKitError } from '~/internal/error-frame.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import { buildStreamHandle } from '~/primitives/stream/handle.ts';
import { StreamState } from '~/primitives/stream/state.ts';
import type { WSKitError } from '@wskit/core';
import type { PrimitiveLogger, WireMessage, WSKitEnvelope } from '~/internal/runtime.ts';
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

/** True if a chunk's scope markers match what an `onStream` subscriber asked for. */
function scopeMatches(
  scope: ScopeMarkers | undefined,
  envelope: WSKitEnvelope | undefined,
): boolean {
  if (!scope) return envelope?.channel === undefined;
  return scope.channel === envelope?.channel && scope.channelScope === envelope?.channelScope;
}

/** The `stream-aborted` reason on an error, if any. */
function abortReason(error: WSKitError): string | undefined {
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
 * by `seq`, and resumable streams restart automatically on reconnect.
 */
export function stream(options: StreamOptions = {}): StreamPrimitive {
  const timeout = options.timeout ?? 30_000;
  const nudgeTimeout = options.nudgeTimeout ?? 10_000;
  // A resume can legitimately take longer than a single chunk gap (the server may
  // be replaying a buffer), so the resume deadline is more generous than the
  // per-chunk timeout. It only bounds the wait so a server that never resumes
  // can't hang the iterator forever. Disabled when per-chunk timeouts are off.
  const resumeDeadline = timeout <= 0 ? 0 : Math.max(timeout, 30_000);

  return {
    _tag: 'stream',
    // A channel-scoped resume frame requires channel membership to be set up
    // first (same as replaying missed messages). Run after channels when present.
    optionalAfter: ['channels'],
    setup(helpers) {
      const streams = new Map<string, StreamState>();
      const triggers = new Map<string, Trigger>();
      const broadcastSubs = new Map<string, Set<BroadcastSub>>();
      const broadcastRuns = new Map<string, BroadcastRun>();
      // Nudges awaiting a __nudgeOk__ / __error__, keyed by streamNudgeId.
      const pendingNudges = new Map<string, PendingNudge>();
      // Trigger frames for streams started before the socket was open with no
      // buffering installed to hold them, keyed by streamId. helpers.send drops
      // while not open, so they are held here and flushed on open — otherwise the
      // stream would never start (and with timeout 0 the promise would never
      // settle, leaking the lazy hold).
      const triggerOutbox = new Map<string, WireMessage>();

      function startChunkTimer(state: StreamState): void {
        if (state.timer) clearTimeout(state.timer);
        if (timeout <= 0) return;
        state.timer = setTimeout(() => {
          helpers.log.info(`stream '${state.streamId}' timed out`);
          finishStream(state, Timeout());
        }, timeout);
      }

      // `error` undefined means a clean end (the loop exits); an error makes it throw.
      // `releaseHold` is false only when the kept stream already released its lazy
      // hold on the drop (see onClose) — finishing it later must not double-release.
      function finishStream(state: StreamState, error?: unknown, releaseHold = true): void {
        if (!state.active) return;
        state.active = false;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        if (state.resumeTimer) clearTimeout(state.resumeTimer);
        state.resumeTimer = null;
        streams.delete(state.streamId);
        if (releaseHold) helpers.lazyRelease();
        if (error) state.queue.abort(error);
        else state.queue.end();
      }

      // Settle a pending nudge by its id (resolve on __nudgeOk__, reject on error).
      function settleNudge(id: string | undefined, run: (pending: PendingNudge) => void): void {
        if (id === undefined) return;
        const pending = pendingNudges.get(id);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        pendingNudges.delete(id);
        run(pending);
      }

      function resumeFrame(state: StreamState, lastKnownSeq?: number): WireMessage {
        const seq = lastKnownSeq ?? (Number.isFinite(state.lastSeq) ? state.lastSeq : undefined);
        return {
          event: '__resumeStream__',
          payload: seq !== undefined ? { lastKnownSeq: seq } : {},
          __wskit: { streamId: state.streamId, ...state.markers },
        };
      }

      const handleDependencies: StreamHandleDependencies = {
        nudge(state, details) {
          const { event, payload } = details;
          const streamNudgeId = helpers.generateId('nudge');
          helpers.rawSend({
            event,
            payload,
            __wskit: { streamId: state.streamId, ...state.markers, streamNudgeId },
          });
          const timeoutMs = details.timeout ?? nudgeTimeout;
          return new Promise<void>((resolve, reject) => {
            const timer =
              timeoutMs > 0
                ? setTimeout(() => {
                    pendingNudges.delete(streamNudgeId);
                    reject(Timeout());
                  }, timeoutMs)
                : null;
            pendingNudges.set(streamNudgeId, { resolve, reject, timer });
          });
        },
        cancel(state) {
          helpers.rawSend({
            event: '__streamCancel__',
            payload: {},
            __wskit: { streamId: state.streamId, ...state.markers },
          });
          finishStream(state); // a cancel ends the loop without throwing
        },
      };

      function triggerStream(
        event: string,
        payload: unknown,
        context: { markers: ScopeMarkers; options?: StreamTriggerOptions },
      ): Promise<StreamHandle<unknown>> {
        const streamId = context.options?.streamId ?? helpers.generateId('stream');
        helpers.ensureConnected();
        helpers.lazyAcquire();
        const frame: WireMessage = { event, payload, __wskit: { streamId, ...context.markers } };
        // Send through the normal path so buffering can take it — queued while
        // offline, or held behind a draining staggered flush so it keeps order. If
        // there is no buffering and we are not open yet, hold it and flush on open.
        let delivered: boolean;
        try {
          delivered = helpers.send(frame);
        } catch (error) {
          helpers.lazyRelease(); // roll back the hold the trigger acquired above
          throw error;
        }
        if (!delivered && helpers.getState() !== 'open') triggerOutbox.set(streamId, frame);

        return new Promise<StreamHandle<unknown>>((resolve, reject) => {
          const timer =
            timeout > 0
              ? setTimeout(() => {
                  triggers.delete(streamId);
                  triggerOutbox.delete(streamId);
                  helpers.lazyRelease();
                  reject(Timeout());
                }, timeout)
              : null;
          triggers.set(streamId, {
            resolve,
            reject,
            timer,
            event,
            markers: context.markers,
          });
        });
      }

      function resumeStream(
        event: string,
        streamId: string,
        context: { markers: ScopeMarkers; options?: { lastKnownSeq?: number } },
      ): StreamHandle<unknown> {
        let state = streams.get(streamId);
        if (!state) {
          state = new StreamState(streamId, event, context.markers);
          state.resumable = true;
          streams.set(streamId, state);
          helpers.lazyAcquire();
        }
        startChunkTimer(state);
        helpers.rawSend(resumeFrame(state, context.options?.lastKnownSeq));
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

      function deliverBroadcast(message: WireMessage, streamId: string): void {
        const { event, payload } = message;
        const envelope = message.__wskit;
        const seq = envelope?.seq;
        const subscribers = broadcastSubs.get(event);
        if (!subscribers || subscribers.size === 0) return;
        const recipients = [...subscribers].filter((subscriber) =>
          scopeMatches(subscriber.scope, envelope),
        );
        if (recipients.length === 0) return;
        let run = broadcastRuns.get(streamId);
        if (!run) {
          run = { event, lastSeq: Number.NEGATIVE_INFINITY, timer: null };
          broadcastRuns.set(streamId, run);
        }
        if (seq !== undefined && seq <= run.lastSeq) return; // already delivered
        if (seq !== undefined) run.lastSeq = seq;
        if (run.timer) clearTimeout(run.timer);
        if (timeout > 0) {
          run.timer = setTimeout(() => {
            helpers.log.info(`broadcast stream '${streamId}' timed out`);
            broadcastRuns.delete(streamId);
            for (const subscriber of broadcastSubs.get(event) ?? [])
              if (scopeMatches(subscriber.scope, envelope))
                callStreamHandler(helpers.log, () => subscriber.handlers.onTimeout?.(streamId));
          }, timeout);
        }
        helpers.log.info(`broadcast stream '${streamId}' chunk received`);
        for (const subscriber of recipients)
          callStreamHandler(helpers.log, () => subscriber.handlers.onChunk(payload, streamId));
      }

      function endBroadcast(
        streamId: string,
        envelope: WSKitEnvelope | undefined,
        notify: (handlers: StreamHandlers<unknown>) => void,
      ): void {
        const active = broadcastRuns.get(streamId);
        if (active?.timer) clearTimeout(active.timer);
        broadcastRuns.delete(streamId);

        // Route only to subscribers of this stream's event (from a live run, or the
        // eventName the server stamps on broadcast terminal frames). A frame whose
        // event can't be resolved — e.g. a private stream's end, which has neither —
        // is left alone; fanning out to every subscriber would misdeliver it.
        const event = active?.event ?? envelope?.eventName;
        if (event === undefined) return;
        for (const subscriber of broadcastSubs.get(event) ?? [])
          if (scopeMatches(subscriber.scope, envelope))
            callStreamHandler(helpers.log, () => notify(subscriber.handlers));
      }

      return {
        id: 'stream',
        onIncoming(message) {
          const envelope = message.__wskit;
          const streamId = envelope?.streamId;
          if (typeof streamId !== 'string') return message;

          switch (message.event) {
            case '__streamOk__': {
              const trigger = triggers.get(streamId);
              if (!trigger) {
                // A resume ack for an already-running stream. The server confirmed
                // the resume, so the stream is alive — drop the one-shot resume
                // deadline. The per-chunk timer stays unstarted until the first
                // resumed chunk lands (as on reconnect), so a slow first chunk
                // can't trip a stale timeout.
                const resumed = streams.get(streamId);
                if (resumed?.resumeTimer) {
                  clearTimeout(resumed.resumeTimer);
                  resumed.resumeTimer = null;
                }
                return null;
              }
              if (trigger.timer) clearTimeout(trigger.timer);
              triggers.delete(streamId);
              triggerOutbox.delete(streamId);
              const state = new StreamState(streamId, trigger.event, trigger.markers);
              // The server tells us whether this stream is resumable.
              state.resumable = envelope?.streamKind === 'persistent';
              streams.set(streamId, state);
              startChunkTimer(state);
              trigger.resolve(buildStreamHandle(state, handleDependencies));
              return null;
            }
            case '__streamEnd__': {
              helpers.log.info(`stream '${streamId}' completed`);
              const state = streams.get(streamId);
              if (state) finishStream(state);
              endBroadcast(streamId, envelope, (handlers) =>
                handlers.onEnd?.(streamId, envelope?.seq),
              );
              return null;
            }
            case '__nudgeOk__': {
              settleNudge(envelope?.streamNudgeId, (pending) => pending.resolve());
              return null;
            }
            case '__error__': {
              if (envelope?.correlationId !== undefined || envelope?.ackId !== undefined)
                return message;
              const error = toWSKitError(message.payload);
              // A non-terminal error (a rejected nudge) settles its nudge() Promise
              // and leaves the stream running.
              if (envelope?.streamTerminated === false) {
                settleNudge(envelope?.streamNudgeId, (pending) => pending.reject(error));
                return null;
              }
              // An error before __streamOk__ (e.g. stream-id-collision,
              // stream-already-active) means the trigger never started — reject
              // the pending stream() promise instead of leaving it to time out.
              const trigger = triggers.get(streamId);
              if (trigger) {
                if (trigger.timer) clearTimeout(trigger.timer);
                triggers.delete(streamId);
                triggerOutbox.delete(streamId);
                helpers.lazyRelease();
                trigger.reject(error);
                return null;
              }
              const state = streams.get(streamId);
              if (state) {
                // A hibernated server tells a durable stream to resume itself.
                if (
                  state.resumable &&
                  error.code === 'stream-aborted' &&
                  abortReason(error) === 'hibernation-wake'
                ) {
                  startChunkTimer(state);
                  helpers.rawSend(resumeFrame(state));
                } else {
                  finishStream(state, error);
                }
              }
              endBroadcast(streamId, envelope, (handlers) => handlers.onError?.(error, streamId));
              return null;
            }
            default: {
              // A chunk. Deliver to the creator's handle and any broadcast listeners.
              if (message.event.startsWith('__')) return message;
              const seq = envelope?.seq;
              const state = streams.get(streamId);
              if (state && (seq === undefined || seq > state.lastSeq)) {
                // The first resumed chunk arrived — drop the resume deadline and
                // hand back over to the normal per-chunk timer.
                if (state.resumeTimer) {
                  clearTimeout(state.resumeTimer);
                  state.resumeTimer = null;
                }
                if (seq !== undefined) state.lastSeq = seq;
                helpers.log.info(`stream '${streamId}' chunk received`);
                state.queue.push(message.payload);
                startChunkTimer(state);
              }
              deliverBroadcast(message, streamId);
              return message;
            }
          }
        },
        onOpen() {
          // Flush trigger frames for streams started while the socket was still
          // connecting; rawSend would have dropped them before open.
          if (triggerOutbox.size === 0) return null;
          const frames = [...triggerOutbox.values()];
          triggerOutbox.clear();
          return frames;
        },
        onReconnect() {
          const frames: WireMessage[] = [];
          for (const state of streams.values()) {
            if (state.active && state.resumable) {
              helpers.lazyAcquire();
              frames.push(resumeFrame(state));
              // Bound the resume: if no resumed chunk arrives, the deadline ends
              // the stream rather than leaving it (and its lazy hold) hung. The
              // per-chunk timer is intentionally NOT started here — it begins only
              // when the first resumed chunk lands.
              if (resumeDeadline > 0) {
                if (state.resumeTimer) clearTimeout(state.resumeTimer);
                state.resumeTimer = setTimeout(() => {
                  state.resumeTimer = null;
                  finishStream(state, Timeout());
                }, resumeDeadline);
              }
            }
          }
          return frames.length ? frames : null;
        },
        onClose(code, reason, intentional) {
          for (const trigger of triggers.values()) {
            if (trigger.timer) clearTimeout(trigger.timer);
            helpers.lazyRelease();
            trigger.reject(Disconnected());
          }
          triggers.clear();
          triggerOutbox.clear();

          for (const pending of pendingNudges.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(Disconnected());
          }
          pendingNudges.clear();

          for (const state of [...streams.values()]) {
            if (state.timer) clearTimeout(state.timer);
            state.timer = null;
            if (state.resumeTimer) clearTimeout(state.resumeTimer);
            state.resumeTimer = null;
            // A durable stream survives an unexpected drop only if the socket can
            // actually reconnect; otherwise the resume that would revive its queue
            // never comes, so finish it (the for-await loop throws Disconnected
            // instead of hanging forever).
            if (state.resumable && !intentional && helpers.willReconnect(code, reason)) {
              helpers.lazyRelease();
            } else {
              finishStream(state, Disconnected());
            }
          }

          for (const run of broadcastRuns.values()) if (run.timer) clearTimeout(run.timer);
          broadcastRuns.clear();
        },
        onReconnectFailed() {
          // Reconnection is abandoned — the resume that would revive a kept stream
          // never comes. Each kept resumable stream already released its lazy hold
          // on the drop (onClose), so finish it without releasing the hold again,
          // making the for-await loop throw Disconnected instead of hanging forever.
          for (const state of [...streams.values()]) finishStream(state, Disconnected(), false);
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
          // @ts-expect-error — install adds resumeStream() to the socket dynamically
          socket.resumeStream = (
            event: string,
            streamId: string,
            resumeOptions?: { lastKnownSeq?: number },
          ) => resumeStream(event, streamId, { markers: {}, options: resumeOptions });

          getAugmenters(socket).push((messaging, scope) => {
            messaging.stream = (
              event: string,
              payload: unknown,
              triggerOptions?: StreamTriggerOptions,
            ) => {
              scope.assertReady?.();
              return triggerStream(event, payload, {
                markers: scope.markers(),
                options: triggerOptions,
              });
            };
            messaging.onStream = (event: string, handlers: StreamHandlers<unknown>) =>
              subscribeBroadcast(event, handlers, scope.markers());
            messaging.resumeStream = (
              event: string,
              streamId: string,
              resumeOptions?: { lastKnownSeq?: number },
            ) => {
              scope.assertReady?.();
              return resumeStream(event, streamId, {
                markers: scope.markers(),
                options: resumeOptions,
              });
            };
          });
        },
      };
    },
  };
}
