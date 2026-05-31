import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '@wskit/server/adapters';
import { DurableObject } from 'cloudflare:workers';
import type { ConnectionHandle, Engine, Logger, ServerDefinition } from '@wskit/server/adapters';
import { createPlatform } from './platform.ts';
import { createStorage, createTimers } from './providers/index.ts';
import { normalizeBinary } from './utils.ts';

/**
 * The instance shape of a `server()`-produced Durable Object.
 *
 * In addition to the standard Durable Object lifecycle methods, the instance
 * exposes `shutdown()` as an RPC method. Call `stub.shutdown()` from your
 * Worker to trigger every `onShutdown` hook and close every open WebSocket
 * connection gracefully — use it before a deploy or maintenance window.
 */
export interface WSKitDurableObjectInstance<Env = unknown> extends DurableObject<Env> {
  shutdown(): Promise<void>;
}

/**
 * The Durable Object class type that `server()` returns. Use this as the type
 * for your exported Durable Object class.
 */
export type CloudflareDurableObjectClass<Env = unknown> = new (
  ctx: DurableObjectState,
  env: Env,
) => WSKitDurableObjectInstance<Env>;

function createAsyncContext<TStore>() {
  return new AsyncLocalStorage<TStore>();
}

const buildServe = adapter<undefined, CloudflareDurableObjectClass>({
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
  // Static capability, declared once next to hibernation — it needs no
  // per-instance state, so it does not belong in the per-DO createEngine call.
  asyncContextFactory: createAsyncContext,

  setup(createEngine) {
    return class WSKitDurableObject<Env = unknown> extends DurableObject<Env> {
      private readonly engine: Engine;
      private readonly liveConnections = new Map<WebSocket, ConnectionHandle>();
      private readonly ready: Promise<void>;

      constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

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

        this.engine = createEngine({
          logger,
          env: (env ?? {}) as Record<string, unknown>,
          platform: createPlatform(ctx, env),
          storage: createStorage(ctx, logger),
          timers: createTimers(ctx),
          waitUntil: (promise: Promise<unknown>) => {
            ctx.waitUntil?.(promise);
          },
        });

        this.ready = ctx.blockConcurrencyWhile(async () => {
          await this.engine.initialize();
          // Boot-time reconcile. With hibernation on, Cloudflare may hand
          // back sockets that survived the eviction — collect their ids
          // from each socket's tiny attachment so the engine keeps those
          // rows and drops any orphans. Hibernation off: the engine
          // short-circuits and the empty set is a no-op.
          const surviving = new Set<string>();
          if (this.engine.usesHibernation()) {
            // Answer the app-level keepalive ping at the edge so a hibernated
            // DO is not woken just to reply "pong". WSKit's client sends the
            // literal text "ping"; the runtime replies "pong" without booting
            // this object. Server-side latency stats pause while hibernated,
            // which is expected.
            this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
            for (const ws of this.ctx.getWebSockets()) {
              const attachment = (ws as WebSocket).deserializeAttachment() as {
                id?: string;
              } | null;
              if (attachment && typeof attachment.id === 'string') {
                surviving.add(attachment.id);
              }
            }
          }
          this.engine.reconcileConnections(surviving);
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
        // identity is always present on an accepted upgrade — onUpgrade
        // requires it on the return type. The fallback to '' keeps this
        // path defensive against an adapter that forgot to forward it.
        return {
          send: (data: string) => socket.send(data),
          sendBinary: (data: ArrayBuffer | ArrayBufferView) => socket.send(data),
          close: (code?: number, reason?: string) => socket.close(code, reason),
          bufferedAmount: () => 0,
          identity: result.identity ?? '',
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

        // Hibernation is opt-in via `hibernation: true` on the contract.
        // Tags are intentionally NOT forwarded into Cloudflare's per-socket
        // tag store. WSKit already persists tags inside its hibernation
        // attachment, so the runtime is the source of truth on wake. The
        // tag store also caps each tag at 256 characters and the total at
        // 10 tags, which does not match the WSKit API contract — passing
        // app tags through would crash the upgrade for any handler that
        // returns more or longer tags from onUpgrade.
        const hibernating = this.engine.usesHibernation();
        if (hibernating) {
          this.ctx.acceptWebSocket(server);
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

      // oxlint-disable-next-line max-params
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
        // Under hibernation Cloudflare keeps sockets open across DO evictions.
        // A new instance starts with an empty in-memory connection map, so a
        // shutdown() RPC right after wake would skip every hibernated socket.
        // Wake each one through the engine first so the shutdown path closes
        // them and runs onDisconnect/cleanup. Wake is idempotent for sockets
        // that were already live in this instance.
        if (this.engine.usesHibernation()) {
          for (const ws of this.ctx.getWebSockets()) {
            this.engine.handleHibernationWake(ws);
          }
        }
        await this.engine.handleShutdown();
      }
    };
  },
});

/**
 * Turn a WSKit handler into a Cloudflare Durable Object class.
 *
 * Export the returned class from your Worker so the Cloudflare runtime can
 * instantiate one DO per `idFromName(...)`. Each DO instance owns its own
 * WebSocket connections, storage, and scheduled alarm. The DO uses the
 * Cloudflare WebSocket Hibernation API when the contract sets
 * `hibernation: true`.
 *
 * The returned value is a class, not an instance. Export it from your worker
 * module like `export const Room = server(handler);` — Cloudflare instantiates
 * it per Durable Object id.
 *
 * @example
 * ```ts
 * // src/worker.ts
 * import { server } from '@wskit/server-cloudflare';
 * import { handler } from './handler';
 *
 * export const GameRoom = server(handler);
 *
 * export default {
 *   async fetch(request, env) {
 *     const id = env.GameRoom.idFromName('lobby');
 *     return env.GameRoom.get(id).fetch(request);
 *   },
 * };
 * ```
 */
export function server(handler: ServerDefinition): CloudflareDurableObjectClass {
  return buildServe(handler, undefined);
}
