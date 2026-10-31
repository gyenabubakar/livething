import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter, isValidCloseCode, normalizeCloseReason } from '@livething/server/adapters';
import { CloseCodes } from '@livething/server/errors';
import { DurableObject } from 'cloudflare:workers';
import type {
  ConnectionHandle,
  Engine,
  EngineRuntimeOptions,
  Logger,
  ServerDefinition,
} from '@livething/server/adapters';
import { buildAdmin } from './admin.ts';
import { createPlatform } from './platform.ts';
import { createStorage, createTimers } from './providers/index.ts';
import type { CloudflareAdmin } from './admin.ts';

/** `WebSocket.READY_STATE_OPEN` on Workers. */
const WEB_SOCKET_OPEN = 1;

/** The close code for a socket that ended with no close frame from the client. */
const ABNORMAL_CLOSURE = 1006;

/**
 * The instance shape of a `bind()`-produced Durable Object.
 *
 * In addition to the standard Durable Object lifecycle methods, the instance
 * exposes two RPC methods. `stub.shutdown()` triggers every `onShutdown` hook
 * and closes every open WebSocket gracefully — use it before a deploy or
 * maintenance window. `stub.admin()` returns the connectionless admin surface,
 * so `const admin = await stub.admin(); await admin.purgeUser(userId)` reaches
 * into the running server from a webhook or cron with no socket of its own.
 */
export interface LiveThingDurableObjectInstance<
  Env = unknown,
  TAdmin = CloudflareAdmin,
> extends DurableObject<Env> {
  /** Gracefully drain the Durable Object: run `onShutdown`, close every socket. */
  shutdown(): Promise<void>;
  /**
   * The connectionless admin surface — `const admin = await stub.admin();
   * await admin.purgeUser(id)`, plus whatever the server definition's own `api` factory
   * returned.
   */
  admin(): Promise<TAdmin>;
}

/**
 * The Durable Object class type that `bind()` returns. Use this as the type
 * for your exported Durable Object class.
 *
 * @template TAdmin What `stub.admin()` resolves to: the built-in operations, typed
 *   against the server definition's own emits, **and** the app's own admin methods.
 */
export type CloudflareDurableObjectClass<Env = unknown, TAdmin = CloudflareAdmin> = new (
  ctx: DurableObjectState,
  env: Env,
) => LiveThingDurableObjectInstance<Env, TAdmin>;

function createAsyncContext<TStore>() {
  return new AsyncLocalStorage<TStore>();
}

const buildBind = adapter<undefined, CloudflareDurableObjectClass<unknown, unknown>>({
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

  setup<TApi>(createEngine: (options: EngineRuntimeOptions) => Engine<TApi>) {
    return class LiveThingDurableObject<Env = unknown> extends DurableObject<Env> {
      private readonly engine: Engine<TApi>;
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
          platform: createPlatform(ctx, env),
          storage: createStorage(ctx, logger),
          timers: createTimers(ctx),
        });
        // Durable Object refs can be passed through application code and must
        // carry the stable DO id so a ref from another DO cannot match a local
        // connection with the same generated id.
        this.engine.setInstanceId(ctx.id.toString());

        const ready = ctx.blockConcurrencyWhile(async () => {
          await this.engine.initialize();
          // Restore every surviving socket's membership eagerly so a broadcast reaches members that have not sent since the wake.
          if (this.engine.usesHibernation()) {
            await this.engine.restoreHibernatedConnections(this.ctx.getWebSockets());
            this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
          } else {
            this.engine.reconcileConnections(new Set());
          }
        });
        // Keep the boot failure available to every later lifecycle method,
        // while marking the constructor-owned Promise as observed when no
        // event ever arrives to await it.
        void ready.catch(() => {});
        this.ready = ready;
      }

      private handleRejectedUpgrade(
        result: Awaited<ReturnType<Engine['handleUpgrade']>>,
      ): Response {
        // >= 1000 is a WS close code (HTTP statuses cap at 599); below that, an HTTP status.
        if (result.code !== undefined && result.code >= 1000) {
          const pair = new WebSocketPair();
          pair[1].accept();
          pair[1].close(result.code, normalizeCloseReason(result.reason ?? 'Upgrade rejected'));

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
        let closed = false;
        return {
          // workerd throws on send() after close; report a refused frame instead.
          send: (data: string) => {
            if (socket.readyState !== WEB_SOCKET_OPEN) return false;

            socket.send(data);
            return true;
          },
          close: (code?: number, reason?: string) => {
            if (closed) return;

            closed = true;
            socket.close(code, reason);
          },
          bufferedAmount: () => 0,
          // Cloudflare does not expose outbound buffer fullness, so drain() is a no-op.
          backpressureSupported: false,
          userId: result.userId ?? '',
          meta: result.meta ?? {},
          tags: result.tags ?? [],
        };
      }

      private wireStandardSocket(socket: WebSocket, connection: ConnectionHandle): void {
        socket.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            connection.handleMessage(event.data);
          } else {
            closeBinaryFrame(socket);
          }
        });
        socket.addEventListener('close', (event) => {
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

        const result = await this.engine.handleUpgrade(requestWithClientIp(request));
        if (result.reject) {
          return this.handleRejectedUpgrade(result);
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        const descriptor = this.createConnectionDescriptor(server, result);

        // Tags are NOT forwarded into Cloudflare's per-socket tag store: LiveThing
        // persists them in its hibernation attachment, and the store's caps (10
        // tags, 256 chars each) would crash the upgrade for larger LiveThing tags.
        const hibernating = this.engine.usesHibernation();
        if (hibernating) {
          this.ctx.acceptWebSocket(server);
        } else {
          server.accept();
        }

        let connection: ConnectionHandle;
        try {
          connection = this.engine.accept(server, descriptor);
        } catch (error) {
          descriptor.close(CloseCodes.INTERNAL_ERROR, '[livething] connection setup failed');
          throw error;
        }

        if (!hibernating) {
          this.wireStandardSocket(server, connection);
        }

        return new Response(null, {
          status: 101,
          webSocket: client,
        } as ResponseInit & { webSocket: WebSocket });
      }

      // Cloudflare calls these three methods only for sockets accepted with
      // ctx.acceptWebSocket(), so they always belong to a hibernating engine.
      async webSocketMessage(
        ws: WebSocket,
        message: string | ArrayBuffer | ArrayBufferView,
      ): Promise<void> {
        await this.ready;

        const connection = this.engine.handleHibernationWake(ws);

        if (typeof message === 'string') {
          await connection.handleMessage(message);
          return;
        }

        closeBinaryFrame(ws);
      }

      async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        // First, so a slow hook or a failed boot can't keep the client waiting.
        answerClientClose(ws, code, reason);
        await this.ready;

        await this.engine.handleHibernationWake(ws).handleClose(code, reason);
      }

      async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        await this.ready;

        const connection = this.engine.handleHibernationWake(ws);
        await connection.handleError(error);
        // The runtime has already closed the socket and sends no webSocketClose after an error.
        await connection.handleClose(ABNORMAL_CLOSURE, 'socket error');
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
       * `const admin = await stub.admin(); await admin.purgeUser(userId)` from
       * an auth webhook.
       *
       * Hibernated sockets are woken first (as in `shutdown()`) so an operation
       * like `purgeUser` or `broadcast` reaches every connection, not just
       * the ones already live on this instance.
       */
      // The engine erases the definition's types at runtime; `bind()` casts the
      // finished class back to the definition's own `CloudflareAdmin`.
      async admin(): Promise<unknown> {
        await this.ready;
        if (this.engine.usesHibernation()) {
          for (const ws of this.ctx.getWebSockets()) {
            this.engine.handleHibernationWake(ws);
          }
        }

        return buildAdmin(this.engine.admin(), this.ctx.id.toString());
      }
    };
  },
});

function requestWithClientIp(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete('LiveThing-Client-IP');

  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set('LiveThing-Client-IP', clientIp);

  return new Request(request, { headers });
}

/**
 * Send the close frame that ends a client's close handshake. A hibernating socket
 * doesn't get this from the runtime. 1005 and 1006 only describe a received close
 * and `close()` throws on them, so those close with no code, which a client that
 * sent no code sees as 1005.
 */
function answerClientClose(ws: WebSocket, code: number, reason: string): void {
  if (isValidCloseCode(code)) {
    ws.close(code, reason);
  } else {
    ws.close();
  }
}

function closeBinaryFrame(socket: WebSocket): void {
  socket.close(CloseCodes.UNSUPPORTED_DATA, '[livething] binary frames are not supported yet');
}

/**
 * Turn a LiveThing server definition into a Cloudflare Durable Object class.
 *
 * Export the returned class from your Worker so the Cloudflare runtime can
 * instantiate one DO per `idFromName(...)`. Each DO instance owns its own
 * WebSocket connections, storage, and scheduled alarm. The DO uses the
 * Cloudflare WebSocket Hibernation API when the contract sets
 * `hibernation: true`. The runtime then answers the client's keepalive "ping"
 * with "pong" at the edge, so a hibernated DO is not woken just to reply.
 *
 * The returned value is a class, not an instance. Export it from your worker
 * module with a **class declaration** — Cloudflare instantiates it per Durable
 * Object id:
 *
 * ```ts
 * export class Room extends bind(serverDefinition) {}
 * ```
 *
 * Use a class declaration rather than `export const Room = bind(serverDefinition)`.
 * `wrangler types` writes `DurableObjectNamespace<import("./worker").Room>`,
 * which needs a **type** of that name; a `const` exports only a value, so the
 * binding falls back to `any` and every `stub.…()` call goes unchecked.
 *
 * **LiveThing requires `compatibility_date` `2026-04-07` or later** in
 * `wrangler.jsonc`. From that date the Workers runtime completes a
 * client-initiated close handshake on a standard socket; on earlier dates it
 * does not, so a client that calls `socket.disconnect()` (or `ws.close()`) can
 * hang until a timeout instead of closing promptly. On a hibernating socket the
 * adapter completes the handshake itself in `webSocketClose`. Server-initiated
 * closes are unaffected.
 *
 * @example
 * ```ts
 * // src/worker.ts
 * import { bind } from '@livething/server-cloudflare';
 * import { serverDefinition } from './server-definition';
 *
 * export class GameRoom extends bind(serverDefinition) {}
 *
 * export default {
 *   async fetch(request, env) {
 *     const id = env.GameRoom.idFromName('lobby');
 *     return env.GameRoom.get(id).fetch(request);
 *   },
 * };
 * ```
 */
export function bind<TDefinition extends ServerDefinition>(
  definition: TDefinition,
): CloudflareDurableObjectClass<unknown, CloudflareAdmin<TDefinition>> {
  return buildBind(definition, undefined) as unknown as CloudflareDurableObjectClass<
    unknown,
    CloudflareAdmin<TDefinition>
  >;
}
