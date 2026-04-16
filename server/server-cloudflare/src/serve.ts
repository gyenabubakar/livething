import { defineServerAdapter } from '@wskit/server/adapters';
import { DurableObject } from 'cloudflare:workers';
import type { ConnectionHandle, Engine, ServerDefinition } from '@wskit/server/adapters';
import { createPlatform } from './platform.ts';
import { createStorage, createTimers } from './providers.ts';
import { normalizeBinary } from './utils.ts';

/**
 * Options for the Cloudflare adapter.
 *
 * @property hibernation - If `true` (default), the Durable Object uses the
 * Cloudflare WebSocket hibernation API, which lets the DO be evicted from memory
 * while clients stay connected and resumes it when a message arrives. Set to
 * `false` only if you need standard event-listener semantics (which keeps the DO
 * alive and billable for the full connection lifetime).
 */
export interface CloudflareOptions {
  hibernation?: boolean;
}

/**
 * The instance shape of a `serve()`-produced Durable Object.
 *
 * In addition to the standard DO lifecycle methods, the instance exposes
 * `shutdown()` as an RPC-callable method. Invoke `stub.shutdown()` from your
 * Worker to run `onShutdown` hooks and close open sockets. It is a graceful
 * drain — the DO instance is not destroyed and will accept new connections
 * until Cloudflare idle-evicts it.
 */
export interface WskitDurableObjectInstance<Env = unknown> extends DurableObject<Env> {
  shutdown(): Promise<void>;
}

/**
 * The Durable Object class type that `serve()` returns. Use this as the type
 * for your exported Durable Object class.
 */
export type CloudflareDurableObjectClass<Env = unknown> = new (
  ctx: DurableObjectState,
  env: Env,
) => WskitDurableObjectInstance<Env>;

const buildServe = defineServerAdapter<CloudflareOptions, CloudflareDurableObjectClass>({
  id: 'cloudflare',
  hibernation: (options) => options?.hibernation ?? true,

  setup(createEngine, options) {
    const hibernation = options?.hibernation ?? true;

    return class WskitDurableObject<Env = unknown> extends DurableObject<Env> {
      private readonly engine: Engine;
      private readonly liveConnections = new Map<WebSocket, ConnectionHandle>();
      private readonly ready: Promise<void>;

      constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        this.engine = createEngine();

        this.engine.setEnv((env ?? {}) as Record<string, unknown>);
        this.engine.setPlatform(createPlatform(ctx, env));
        this.engine.setStorage(createStorage(ctx));
        this.engine.setTimerProvider(createTimers(ctx));
        this.engine.setWaitUntil((promise: Promise<unknown>) => {
          ctx.waitUntil?.(promise);
        });

        this.ready = ctx.blockConcurrencyWhile(async () => {
          await this.engine.initialize();
        });
      }

      async fetch(request: Request): Promise<Response> {
        await this.ready;

        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Expected Upgrade: websocket', { status: 426 });
        }

        const result = await this.engine.handleUpgrade(request);
        if (result.reject) {
          if (result.code && result.code >= 1000) {
            const pair = new WebSocketPair();
            pair[1].accept();
            pair[1].close(result.code, result.reason ?? 'Upgrade rejected');
            return new Response(null, {
              status: 101,
              webSocket: pair[0],
            } as ResponseInit & { webSocket: WebSocket });
          }
          const status =
            result.code && result.code >= 400 && result.code <= 599 ? result.code : 403;
          return new Response(result.reason ?? 'Upgrade rejected', { status });
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        const descriptor = {
          send: (data: string) => server.send(data),
          sendBinary: (data: ArrayBuffer | ArrayBufferView) => server.send(data),
          close: (code?: number, reason?: string) => server.close(code, reason),
          bufferedAmount: () => 0,
          meta: result.meta ?? {},
          tags: result.tags ?? [],
        };

        if (hibernation) {
          this.ctx.acceptWebSocket(server, [...(result.tags ?? [])]);
        } else {
          server.accept();
        }

        const connection = this.engine.accept(server, descriptor);
        this.liveConnections.set(server, connection);

        if (!hibernation) {
          server.addEventListener('message', (event) => {
            if (typeof event.data === 'string') {
              connection.handleMessage(event.data);
            } else {
              connection.handleBinary(normalizeBinary(event.data));
            }
          });
          server.addEventListener('close', (event) => {
            this.liveConnections.delete(server);
            connection.handleClose(event.code, event.reason);
          });
          server.addEventListener('error', (event) => {
            connection.handleError(event);
          });
        }

        return new Response(null, {
          status: 101,
          webSocket: client,
        } as ResponseInit & { webSocket: WebSocket });
      }

      private getConnection(ws: WebSocket): ConnectionHandle {
        if (this.engine.usesHibernation()) {
          return this.engine.handleHibernationWake(ws);
        }

        const connection = this.liveConnections.get(ws);
        if (!connection) {
          throw new Error('[wskit] Connection is not active for this websocket.');
        }

        return connection;
      }

      async webSocketMessage(
        ws: WebSocket,
        message: string | ArrayBuffer | ArrayBufferView,
      ): Promise<void> {
        await this.ready;

        const connection = this.getConnection(ws);
        if (typeof message === 'string') {
          await connection.handleMessage(message);
          return;
        }

        await connection.handleBinary(normalizeBinary(message));
      }

      async webSocketClose(
        ws: WebSocket,
        code: number,
        reason: string,
        _wasClean?: boolean,
      ): Promise<void> {
        await this.ready;

        const connection = this.getConnection(ws);
        this.liveConnections.delete(ws);
        await connection.handleClose(code, reason);
      }

      async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        await this.ready;

        const connection = this.getConnection(ws);
        await connection.handleError(error);
      }

      async alarm(): Promise<void> {
        await this.ready;
        await this.engine.handleAlarm();
      }

      /**
       * Gracefully drain this Durable Object.
       *
       * Runs every `onShutdown` hook (handler-level and module-level), cancels
       * active streams, closes every open WebSocket with close code 1001
       * ("going away"), and clears the next queued alarm handle.
       *
       * Cloudflare does not emit a native shutdown signal, so call this from
       * your Worker (e.g. from an admin RPC before a deploy) when you need a
       * clean close. Note that this does **not** destroy the DO instance —
       * Cloudflare will idle-evict it shortly after all connections close.
       * A subsequent upgrade request will re-activate the DO with fresh state.
       * If you need an immediate teardown, call `ctx.abort()` from inside the
       * DO yourself.
       */
      async shutdown(): Promise<void> {
        await this.ready;
        await this.engine.handleShutdown();
      }
    };
  },
});

/**
 * Turn a wskit handler into a Cloudflare Durable Object class.
 *
 * Export the returned class from your Worker so the Cloudflare runtime can
 * instantiate one DO per `idFromName(...)`. Each DO instance owns its own
 * WebSocket connections, storage, and scheduled alarm. By default the DO
 * uses the Hibernation API (see {@link CloudflareOptions}).
 *
 * @example
 * ```ts
 * // src/worker.ts
 * import { serve } from '@wskit/server-cloudflare';
 * import { handler } from './handler';
 *
 * export const GameRoom = serve(handler);
 *
 * export default {
 *   async fetch(request, env) {
 *     const id = env.GameRoom.idFromName('lobby');
 *     return env.GameRoom.get(id).fetch(request);
 *   },
 * };
 * ```
 */
export function serve(
  handler: ServerDefinition,
  options?: CloudflareOptions,
): CloudflareDurableObjectClass {
  return buildServe(handler, options ?? {});
}
