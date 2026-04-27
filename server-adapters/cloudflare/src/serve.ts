import { defineServerAdapter } from '@wskit/server/adapters';
import { DurableObject } from 'cloudflare:workers';
import type { ConnectionHandle, Engine, Logger, ServerDefinition } from '@wskit/server/adapters';
import { createPlatform } from './platform.ts';
import { createStorage, createTimers } from './providers.ts';
import { normalizeBinary } from './utils.ts';

/**
 * The instance shape of a `serve()`-produced Durable Object.
 *
 * In addition to the standard Durable Object lifecycle methods, the instance
 * exposes `shutdown()` as an RPC method. Call `stub.shutdown()` from your
 * Worker to trigger every `onShutdown` hook and close every open WebSocket
 * connection gracefully — use it before a deploy or maintenance window.
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

const buildServe = defineServerAdapter<undefined, CloudflareDurableObjectClass>({
  id: 'cloudflare',
  // Persist per-socket snapshots through Cloudflare's attachment slot so the
  // engine never reaches into platform-specific WebSocket APIs directly.
  hibernation: {
    persist(wsKey, snapshot) {
      (wsKey as WebSocket).serializeAttachment(snapshot);
    },
    restore(wsKey) {
      return (wsKey as WebSocket).deserializeAttachment();
    },
  },

  setup(createEngine) {
    return class WskitDurableObject<Env = unknown> extends DurableObject<Env> {
      private readonly engine: Engine;
      private readonly liveConnections = new Map<WebSocket, ConnectionHandle>();
      private readonly ready: Promise<void>;

      constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        this.engine = createEngine();

        const logger: Logger = {
          info(message: string, data?: Record<string, unknown>) {
            console.log(message, data ?? {});
          },
          warn(message: string, data?: Record<string, unknown>) {
            console.warn(message, data ?? {});
          },
          error(message: string, data?: Record<string, unknown>) {
            console.error(message, data ?? {});
          },
        };

        this.engine.setLogger(logger);
        this.engine.setEnv((env ?? {}) as Record<string, unknown>);
        this.engine.setPlatform(createPlatform(ctx, env));
        this.engine.setStorage(createStorage(ctx, logger));
        this.engine.setTimerProvider(createTimers(ctx));
        this.engine.setWaitUntil((promise: Promise<unknown>) => {
          ctx.waitUntil?.(promise);
        });

        this.ready = ctx.blockConcurrencyWhile(async () => {
          await this.engine.initialize();
        });
      }

      private handleRejectedUpgrade(
        result: Awaited<ReturnType<Engine['handleUpgrade']>>,
      ): Response {
        // WebSocket close codes start at 1000 and HTTP statuses cap at 599, so >= 1000 -> treat as a WS close code; otherwise -> HTTP status.
        if (result.code && result.code >= 1000) {
          const pair = new WebSocketPair();
          pair[1].accept();
          pair[1].close(result.code, result.reason ?? 'Upgrade rejected');
          return new Response(null, {
            status: 101,
            webSocket: pair[0],
          } as ResponseInit & { webSocket: WebSocket });
        }

        const status = result.code && result.code >= 400 && result.code <= 599 ? result.code : 403;
        return new Response(result.reason ?? 'Upgrade rejected', { status });
      }

      private createConnectionDescriptor(
        socket: WebSocket,
        result: Awaited<ReturnType<Engine['handleUpgrade']>>,
      ) {
        return {
          send: (data: string) => socket.send(data),
          sendBinary: (data: ArrayBuffer | ArrayBufferView) => socket.send(data),
          close: (code?: number, reason?: string) => socket.close(code, reason),
          bufferedAmount: () => 0,
          meta: result.meta ?? {},
          tags: result.tags ?? [],
        };
      }

      private wireStandardSocket(socket: WebSocket, connection: ConnectionHandle): void {
        socket.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            connection.handleMessage(event.data);
          } else {
            connection.handleBinary(normalizeBinary(event.data));
          }
        });
        socket.addEventListener('close', (event) => {
          this.liveConnections.delete(socket);
          connection.handleClose(event.code, event.reason);
        });
        socket.addEventListener('error', (event) => {
          connection.handleError(event);
        });
      }

      async fetch(request: Request): Promise<Response> {
        await this.ready;

        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Expected Upgrade: websocket', { status: 426 });
        }

        const result = await this.engine.handleUpgrade(request);
        if (result.reject) {
          return this.handleRejectedUpgrade(result);
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const descriptor = this.createConnectionDescriptor(server, result);

        // Hibernation is opt-in at the handler level via `.hibernation()`.
        const hibernating = this.engine.usesHibernation();
        if (hibernating) {
          this.ctx.acceptWebSocket(server, [...(result.tags ?? [])]);
        } else {
          server.accept();
        }

        const connection = this.engine.accept(server, descriptor);
        this.liveConnections.set(server, connection);

        if (!hibernating) {
          this.wireStandardSocket(server, connection);
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
       * Runs every `onShutdown` hook you registered and closes every open
       * WebSocket cleanly. Cloudflare doesn't emit a native shutdown signal,
       * so this is the intended way to trigger a clean close from your
       * Worker — call it from an admin RPC before a deploy or maintenance
       * window so clients can reconnect to a fresh instance.
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
 * uses the Cloudflare WebSocket Hibernation API when the handler calls
 * `.hibernation()`.
 *
 * The returned value is a class, not an instance. Export it from your worker
 * module like `export const Room = serve(handler);` — Cloudflare instantiates
 * it per Durable Object id.
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
export function serve(handler: ServerDefinition): CloudflareDurableObjectClass {
  return buildServe(handler, undefined);
}
