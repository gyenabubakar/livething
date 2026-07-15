import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '@wskit/server/adapters';
import { DurableObject, RpcTarget } from 'cloudflare:workers';
import type { ConnectionHandle, Engine, Logger, ServerDefinition } from '@wskit/server/adapters';
import { createPlatform } from './platform.ts';
import { createStorage, createTimers } from './providers/index.ts';

/**
 * The connectionless admin surface reached with `stub.admin()`. Extends
 * `RpcTarget` so its methods are callable across the Worker→DO stub. The
 * framework's built-in operations are declared here; the app's own `api`
 * methods (authored on `assemble({ handlers, api })`) are attached per instance.
 * Built-in names win — an app api method cannot shadow one.
 *
 * The dev `api` factory runs against the full connectionless context (channels,
 * tags, sql, and the rest); those richer members are used inside your api
 * methods, not surfaced directly over the stub.
 */
export class WSKitAdmin extends RpcTarget {
  readonly #api: Record<string, unknown>;

  constructor(api: Record<string, unknown>) {
    super();
    this.#api = api;
    // Expose the app's own api methods over the stub, unless they collide with a
    // built-in below (built-ins win).
    for (const [key, value] of Object.entries(api)) {
      if (typeof value === 'function' && !(key in WSKitAdmin.prototype)) {
        (this as Record<string, unknown>)[key] = value;
      }
    }
  }

  #call<T>(op: string, args: unknown[]): T {
    return (this.#api[op] as (...a: unknown[]) => T)(...args);
  }

  /** Broadcast an event to every live connection. */
  broadcast(event: string, payload: unknown): void {
    this.#call('broadcast', [event, payload]);
  }

  /** Drop a user everywhere: channels, durable rows, and their live sockets. */
  purgeIdentity(identity: string): Promise<void> {
    return this.#call('purgeIdentity', [identity]);
  }

  /** Close live connections — all of them, or only one identity's. */
  closeConnections(filter?: { identity?: string }, code?: number, reason?: string): void {
    this.#call('closeConnections', [filter, code, reason]);
  }

  /** A snapshot of every live connection. */
  getConnections(): unknown[] {
    return this.#call('getConnections', []);
  }
}

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
  admin(): Promise<WSKitAdmin>;
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
  hibernation: {
    persist(wsKey, snapshot) {
      (wsKey as WebSocket).serializeAttachment(snapshot);
    },
    restore(wsKey) {
      return (wsKey as WebSocket).deserializeAttachment();
    },
  },
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
          // Restore every surviving socket's membership eagerly so a broadcast reaches members that have not sent since the wake.
          if (this.engine.usesHibernation()) {
            this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
            this.engine.restoreHibernatedConnections(this.ctx.getWebSockets());
          } else {
            this.engine.reconcileConnections(new Set());
          }
        });
      }

      private handleRejectedUpgrade(
        result: Awaited<ReturnType<Engine['handleUpgrade']>>,
      ): Response {
        // >= 1000 is a WS close code (HTTP statuses cap at 599); below that, an HTTP status.
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
          close: (code?: number, reason?: string) => socket.close(code, reason),
          bufferedAmount: () => 0,
          // Cloudflare does not expose outbound buffer fullness, so drain() is a no-op.
          backpressureSupported: false,
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
            // Binary unsupported. A throw here is swallowed by event dispatch
            // (frame dropped, socket left open), so close loudly instead.
            // 1003 = "unsupported data"; the close listener runs cleanup.
            socket.close(1003, '[wskit] binary frames are not supported yet');
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

        // Tags are NOT forwarded into Cloudflare's per-socket tag store: WSKit
        // persists them in its hibernation attachment, and the store's caps (10
        // tags, 256 chars each) would crash the upgrade for larger WSKit tags.
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

        throw new Error('[wskit] binary frames are not supported yet');
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
       *
       * Under hibernation Cloudflare keeps sockets open across DO evictions, and
       * a fresh instance starts with an empty connection map. So each hibernated
       * socket is woken through the engine first — otherwise the drain would skip
       * it and leave the client open. Wake is idempotent for already-live sockets.
       */
      async shutdown(): Promise<void> {
        await this.ready;
        if (this.engine.usesHibernation()) {
          for (const ws of this.ctx.getWebSockets()) {
            this.engine.handleHibernationWake(ws);
          }
        }
        await this.engine.handleShutdown();
      }

      /**
       * The connectionless admin surface — reach it from your Worker as
       * `stub.admin()` and call an operation on the result, e.g.
       * `await stub.admin().purgeIdentity(userId)` from an auth webhook.
       *
       * Hibernated sockets are woken first (as in `shutdown()`) so an operation
       * like `purgeIdentity` or `broadcast` reaches every connection, not just
       * the ones already live on this instance.
       */
      async admin(): Promise<WSKitAdmin> {
        await this.ready;
        if (this.engine.usesHibernation()) {
          for (const ws of this.ctx.getWebSockets()) {
            this.engine.handleHibernationWake(ws);
          }
        }
        return new WSKitAdmin(this.engine.admin());
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
 * `hibernation: true`. Under hibernation the runtime answers the client's
 * keepalive "ping" with "pong" at the edge, so a hibernated DO is not woken
 * just to reply (server-side latency stats pause while hibernated, as
 * expected).
 *
 * The returned value is a class, not an instance. Export it from your worker
 * module like `export const Room = server(handler);` — Cloudflare instantiates
 * it per Durable Object id.
 *
 * **WSKit requires `compatibility_date` `2026-04-07` or later** in
 * `wrangler.jsonc`. On that date the Workers runtime completes a
 * client-initiated WebSocket close handshake itself; on earlier dates it does
 * not, so a client that calls `socket.disconnect()` (or `ws.close()`) can hang
 * until a timeout instead of closing promptly. Server-initiated closes are
 * unaffected.
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
