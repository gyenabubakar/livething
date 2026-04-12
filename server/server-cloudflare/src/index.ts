import { defineServerAdapter, Engine } from '@wskit/server-codegen/adapters';
import { DurableObject } from 'cloudflare:workers';
import type {
  KVProvider,
  SQLProvider,
  StorageProvider,
  TimerProvider,
} from '@wskit/server-codegen';
import type { ServerDefinition } from '@wskit/server-codegen/adapters';
import type { DurableObjectState } from 'cloudflare:workers';

export interface Platform<Env = unknown> {
  ctx: {
    blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T>;
    getWebSockets(tag?: string): WebSocket[];
    waitUntil?(promise: Promise<unknown>): void;
    storage: {
      transactionSync?<T>(closure: () => T): T;
    };
  };
  env: Env;
}

function createSql(state: DurableObjectState): SQLProvider {
  return {
    exec(query, ...params) {
      return state.storage.sql.exec(query, ...params);
    },
    transaction<T>(
      fn: (tx: { exec(query: string, ...params: unknown[]): ReturnType<SQLProvider['exec']> }) => T,
    ): T {
      if (typeof state.storage.sql.transactionSync === 'function') {
        return state.storage.sql.transactionSync(() =>
          fn({
            exec: (query, ...params) => state.storage.sql.exec(query, ...params),
          }),
        );
      }

      return fn({
        exec: (query, ...params) => state.storage.sql.exec(query, ...params),
      });
    },
  };
}

function createKv(state: DurableObjectState): KVProvider {
  return {
    async get(key) {
      const entry = (await state.storage.get(key)) as
        | { value: unknown; expiresAt?: number }
        | undefined;
      if (!entry) return undefined;
      if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        await state.storage.delete(key);
        return undefined;
      }
      return entry.value;
    },
    async set(key, value, options) {
      await state.storage.put(key, {
        value,
        expiresAt: options?.ttl ? Date.now() + options.ttl : undefined,
      });
    },
    async delete(key) {
      await state.storage.delete(key);
    },
    async list(prefix) {
      const result = await state.storage.list({ prefix });
      return [...result.keys].map((entry) => entry.name);
    },
  };
}

function createStorage(state: DurableObjectState): StorageProvider {
  return {
    sql: createSql(state),
    kv: createKv(state),
  };
}

function createTimers(state: DurableObjectState): TimerProvider {
  return {
    async setAlarm(timeMs) {
      await state.storage.setAlarm(timeMs);
    },
    async deleteAlarm() {
      await state.storage.deleteAlarm();
    },
    async getAlarm() {
      return state.storage.getAlarm();
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}

function createPlatform<Env>(state: DurableObjectState, env: Env): Platform<Env> {
  return {
    ctx: {
      blockConcurrencyWhile: state.blockConcurrencyWhile.bind(state),
      getWebSockets: state.getWebSockets.bind(state),
      waitUntil: state.waitUntil?.bind(state),
      storage: {
        transactionSync: state.storage.transactionSync?.bind(state.storage),
      },
    },
    env,
  };
}

function normalizeBinary(message: string | ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (message instanceof ArrayBuffer) return message;
  if (ArrayBuffer.isView(message)) {
    return message.buffer.slice(
      message.byteOffset,
      message.byteOffset + message.byteLength,
    ) as ArrayBuffer;
  }
  return new TextEncoder().encode(message).buffer;
}

const buildServe = defineServerAdapter<void, ReturnType<typeof createDurableObjectClass>>({
  id: 'cloudflare',
  hibernation: true,
  setup(handler, _engine, _options) {
    return createDurableObjectClass(handler);
  },
});

export type CloudflareDurableObjectClass<Env = unknown> = new (
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env>;

function createDurableObjectClass(handler: ServerDefinition) {
  return class WskitDurableObject<Env = unknown> extends DurableObject<Env> {
    private readonly engine: Engine;
    private readonly liveConnections = new Map<WebSocket, ReturnType<Engine['accept']>>();
    private readonly ready: Promise<void>;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);

      this.engine = new Engine(handler, {
        adapterId: 'cloudflare',
        hibernation: true,
      });

      this.engine.setEnv((env ?? {}) as Record<string, unknown>);
      this.engine.setPlatform(createPlatform(ctx, env));
      this.engine.setStorage(createStorage(ctx));
      this.engine.setTimerProvider(createTimers(ctx));
      this.engine.setWaitUntil((promise) => {
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
        const status = result.code && result.code >= 400 && result.code <= 599 ? result.code : 403;
        return new Response(result.reason ?? 'Upgrade rejected', { status });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.ctx.acceptWebSocket(server, [...(result.tags ?? [])]);

      const connection = this.engine.accept(server, {
        send: (data) => server.send(data),
        sendBinary: (data) => server.send(data),
        close: (code, reason) => server.close(code, reason),
        bufferedAmount: () => 0,
        meta: result.meta ?? {},
        tags: result.tags ?? [],
      });
      this.liveConnections.set(server, connection);

      return new Response(null, {
        status: 101,
        webSocket: client as never,
      } as ResponseInit & { webSocket: WebSocket });
    }

    private getConnection(ws: WebSocket) {
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
}

export function serve(handler: ServerDefinition) {
  return buildServe(handler, undefined) as CloudflareDurableObjectClass;
}
