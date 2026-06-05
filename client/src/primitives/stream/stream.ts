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
  handlers: StreamHandlers<unknown>[];
}

/** True if a chunk's scope markers match what an `onStream` subscriber asked for. */
function scopeMatches(
  scope: ScopeMarkers | undefined,
  envelope: WSKitEnvelope | undefined,
): boolean {
  if (!scope) return envelope?.channel === undefined && envelope?.namespace === undefined;
  return (
    scope.channel === envelope?.channel &&
    scope.channelScope === envelope?.channelScope &&
    scope.namespace === envelope?.namespace
  );
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
    log.error('a stream handler threw', error);
  }
}

/**
 * Streaming / chunked messages. `socket.stream()` triggers a stream and hands
 * back an async iterable of chunks; `socket.onStream()` listens to broadcast
 * streams. The primitive groups frames by `__wskit.streamId`, drops chunks it
 * has already delivered (by `seq`), and resumes durable streams on reconnect.
 */
export function stream(options: StreamOptions = {}): StreamPrimitive {
  const timeout = options.timeout ?? 30_000;
  const nudgeTimeout = options.nudgeTimeout ?? 10_000;

  return {
    _tag: 'stream',
    // A channel-scoped stream resume frame hits the same membership gate as
    // replay, so re-subscribe must go out first. Order after channels when present.
    optionalAfter: ['channels'],
    setup(helpers) {
      const streams = new Map<string, StreamState>();
      const triggers = new Map<string, Trigger>();
      const broadcastSubs = new Map<string, Set<BroadcastSub>>();
      const broadcastRuns = new Map<string, BroadcastRun>();
      // Nudges awaiting a __nudgeOk__ / __error__, keyed by streamNudgeId.
      const pendingNudges = new Map<string, PendingNudge>();

      function startChunkTimer(state: StreamState): void {
        if (state.timer) clearTimeout(state.timer);
        if (timeout <= 0) return;
        state.timer = setTimeout(() => {
          helpers.log.info(`stream '${state.streamId}' timed out`);
          finishStream(state, Timeout());
        }, timeout);
      }

      // `error` undefined means a clean end (the loop exits); an error makes it throw.
      function finishStream(state: StreamState, error?: unknown): void {
        if (!state.active) return;
        state.active = false;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        streams.delete(state.streamId);
        helpers.lazyRelease();
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
        helpers.rawSend({ event, payload, __wskit: { streamId, ...context.markers } });

        return new Promise<StreamHandle<unknown>>((resolve, reject) => {
          const timer =
            timeout > 0
              ? setTimeout(() => {
                  triggers.delete(streamId);
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
        return () => {
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
        let run = broadcastRuns.get(streamId);
        if (!run) {
          const handlers = [...subscribers]
            .filter((subscriber) => scopeMatches(subscriber.scope, envelope))
            .map((subscriber) => subscriber.handlers);
          if (handlers.length === 0) return;
          run = { event, lastSeq: Number.NEGATIVE_INFINITY, timer: null, handlers };
          broadcastRuns.set(streamId, run);
        }
        if (seq !== undefined && seq <= run.lastSeq) return; // already delivered
        if (seq !== undefined) run.lastSeq = seq;
        if (run.timer) clearTimeout(run.timer);
        if (timeout > 0) {
          const current = run;
          current.timer = setTimeout(() => {
            helpers.log.info(`broadcast stream '${streamId}' timed out`);
            broadcastRuns.delete(streamId);
            for (const handler of current.handlers)
              callStreamHandler(helpers.log, () => handler.onTimeout?.(streamId));
          }, timeout);
        }
        helpers.log.info(`broadcast stream '${streamId}' chunk received`);
        for (const handler of run.handlers)
          callStreamHandler(helpers.log, () => handler.onChunk(payload, streamId));
      }

      function endBroadcast(
        streamId: string,
        notify: (handlers: StreamHandlers<unknown>) => void,
      ): void {
        const active = broadcastRuns.get(streamId);
        if (!active) return;
        if (active.timer) clearTimeout(active.timer);
        broadcastRuns.delete(streamId);
        for (const handler of active.handlers)
          callStreamHandler(helpers.log, () => notify(handler));
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
              if (!trigger) return null; // a resume ack for an already-running stream
              if (trigger.timer) clearTimeout(trigger.timer);
              triggers.delete(streamId);
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
              endBroadcast(streamId, (handlers) => handlers.onEnd?.(streamId, envelope?.seq));
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
              endBroadcast(streamId, (handlers) => handlers.onError?.(error, streamId));
              return null;
            }
            default: {
              // A chunk. Deliver to the creator's handle and any broadcast listeners.
              if (message.event.startsWith('__')) return message;
              const seq = envelope?.seq;
              const state = streams.get(streamId);
              if (state && (seq === undefined || seq > state.lastSeq)) {
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
        onReconnect() {
          const frames: WireMessage[] = [];
          for (const state of streams.values()) {
            if (state.active && state.resumable) {
              frames.push(resumeFrame(state));
              startChunkTimer(state);
            }
          }
          return frames.length ? frames : null;
        },
        onClose(_code, _reason, intentional) {
          for (const trigger of triggers.values()) {
            if (trigger.timer) clearTimeout(trigger.timer);
            helpers.lazyRelease();
            trigger.reject(Disconnected());
          }
          triggers.clear();

          for (const pending of pendingNudges.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(Disconnected());
          }
          pendingNudges.clear();

          for (const state of [...streams.values()]) {
            if (state.timer) clearTimeout(state.timer);
            state.timer = null;
            // Durable streams survive an unexpected drop and resume on reconnect.
            if (!(state.resumable && !intentional)) finishStream(state, Disconnected());
          }

          for (const run of broadcastRuns.values()) if (run.timer) clearTimeout(run.timer);
          broadcastRuns.clear();
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
