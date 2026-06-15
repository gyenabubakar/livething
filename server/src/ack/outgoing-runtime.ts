/* oxlint-disable @typescript-eslint/no-explicit-any */
import { error } from '@wskit/core';
import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import { assertLocalRef } from '~/_engine/runtime/refs.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as PublicApi from '~/context.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * Thrown into a `ctx.sendWithAck(...)` promise when no confirmation arrives
 * before the timeout. Shares the `'timeout'` code family with `ctx.request`'s
 * `Timeout` so a server author matches it the same way.
 */
const Timeout = /* @__PURE__ */ error('timeout');

/**
 * Thrown into a `ctx.sendWithAck(...)` promise when the target connection drops
 * before it confirms. Shares the `'disconnected'` code family.
 */
const Disconnected = /* @__PURE__ */ error('disconnected');

/** The built-in wait for a server→client ack receipt, in ms. */
const DEFAULT_ACK_TIMEOUT_MS = 10_000;

/** One in-flight server→client `sendWithAck`, keyed by ackId. */
interface PendingAck {
  resolve: () => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  connectionId: string;
}

/** Per-send options accepted by every `sendWithAck` surface. */
interface AckOptions {
  timeout?: number;
}

/**
 * Build the per-engine pending-ack map and the `sendWithAck` helper every
 * server→client ack surface (`ctx.sendWithAck`, `ctx.connection(ref).sendWithAck`,
 * `ctx.channel.sendWithAck`) shares. The map lives here, in the ack capability,
 * so the engine core never imports it.
 */
function createOutgoingAckRuntime(engine: EngineAccess, defaultTimeoutMs: number) {
  const pending = new Map<string, PendingAck>();

  /** An inbound `__ack__` echoing this `ackId` resolves the matching pending send. */
  function settle(ackId: string): boolean {
    const entry = pending.get(ackId);
    if (!entry) return false;
    pending.delete(ackId);
    clearTimeout(entry.timer);
    entry.resolve();
    return true;
  }

  /** Reject every pending ack waiting on a connection that just dropped. */
  function rejectForConnection(connectionId: string): void {
    for (const [ackId, entry] of pending) {
      if (entry.connectionId !== connectionId) continue;
      pending.delete(ackId);
      clearTimeout(entry.timer);
      entry.reject(Disconnected());
    }
  }

  function sendWithAck(args: {
    target: { connectionId: string; channel?: string; channelScope?: string | null };
    event: string;
    payload: unknown;
    options: AckOptions | undefined;
  }): Promise<void> {
    const { target, event, payload, options } = args;
    const ackId = engine.generateId('sack');
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(ackId);
        reject(Timeout());
      }, options?.timeout ?? defaultTimeoutMs);

      pending.set(ackId, { resolve, reject, timer, connectionId: target.connectionId });

      const sent = engine.sendServerWithAck(target.connectionId, {
        event,
        payload,
        ackId,
        channel: target.channel,
        channelScope: target.channelScope,
      });
      if (!sent) {
        // No live socket for this connection — fail fast instead of waiting out
        // the timeout for a confirmation that can never come.
        pending.delete(ackId);
        clearTimeout(timer);
        reject(Disconnected());
      }
    });
  }

  return { settle, rejectForConnection, sendWithAck };
}

/**
 * The runtime primitive the `ack({...})` capability contributes for the
 * server→client direction. Its `__setup` installs the `sendWithAck` surfaces
 * (`ctx.sendWithAck`, `ctx.connection(ref).sendWithAck`, `ctx.channel.sendWithAck`)
 * and the inbound `__ack__` + disconnect seams. The pending-ack map lives in this
 * module, so the engine core never imports it (tree-shaking: a server without
 * `ack()` pulls none of this).
 */
export function makeOutgoingAckPrimitive(defaultTimeoutMs?: number): Primitive {
  return {
    __wskit: 'outgoing-ack',
    __kind: 'infrastructure',
    __identity: [OUTGOING_ACK_KEY],
    __requires: {},
    __setup(engine: EngineAccess) {
      const runtime = createOutgoingAckRuntime(engine, defaultTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);

      engine.onAckFrame((_connectionId, ackId) => runtime.settle(ackId));

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

        // ctx.sendWithAck — confirm receipt from the current connection. Inside a
        // channel handler it stamps the channel scope on the outgoing frame.
        if (connectionId) {
          extra.sendWithAck = (event: string, payload: unknown, options?: AckOptions) =>
            runtime.sendWithAck({
              target: {
                connectionId,
                channel: scope.channelName,
                channelScope: scope.channelScope,
              },
              event,
              payload,
              options,
            });
        }

        // ctx.connection(ref).sendWithAck — confirm receipt from one specific
        // connection by ref.
        const coreConnection = ctx.connection;
        if (typeof coreConnection === 'function') {
          extra.connection = (ref: PublicApi.ConnectionRef) => {
            const handle = coreConnection(ref) as PublicApi.ConnectionHandle &
              Record<string, unknown>;
            handle.sendWithAck = (event: string, payload: unknown, options?: AckOptions) => {
              const self = (ctx as { self?: PublicApi.ConnectionRef }).self;
              assertLocalRef(ref, self?.instance, 'ctx.connection(ref).sendWithAck');
              return runtime.sendWithAck({
                target: { connectionId: ref.id },
                event,
                payload,
                options,
              });
            };
            return handle;
          };
        }

        // ctx.channel.sendWithAck — confirm receipt from the calling connection
        // inside this channel, stamping the channel scope so the client echoes
        // the ack through it.
        const channelHandle = ctx.channel as
          | (PublicApi.ChannelHandle & Record<string, unknown>)
          | undefined;
        if (channelHandle && connectionId) {
          channelHandle.sendWithAck = (event: string, payload: unknown, options?: AckOptions) =>
            runtime.sendWithAck({
              target: {
                connectionId,
                channel: channelHandle.name,
                channelScope: channelHandle.scope ?? null,
              },
              event,
              payload,
              options,
            });
        }

        return extra;
      });
    },
  };
}

/** @internal Identity of the outgoing-ack install primitive. */
const OUTGOING_ACK_KEY = Symbol('outgoing-ack');
