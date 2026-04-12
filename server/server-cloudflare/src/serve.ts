import { DurableObject } from 'cloudflare:workers';
import { defineServerAdapter } from '@wskit/server/adapters';
import type { ConnectionHandle, Engine, ServerDefinition } from '@wskit/server/adapters';
import { createPlatform } from './platform.ts';
import { createStorage, createTimers } from './providers.ts';
import { normalizeBinary } from './utils.ts';

export interface CloudflareOptions {
  hibernation?: boolean;
}

export type CloudflareDurableObjectClass<Env = unknown> = new (
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env>;

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
    };
  },
});

export function serve(
  handler: ServerDefinition,
  options?: CloudflareOptions,
): CloudflareDurableObjectClass {
  return buildServe(handler, options ?? {});
}
