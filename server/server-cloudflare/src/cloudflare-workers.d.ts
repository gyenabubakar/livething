declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }

  export interface DurableObjectStorageSqlResult {
    toArray(): Record<string, unknown>[];
    one(): Record<string, unknown> | null;
    raw(): unknown[][];
  }

  export interface DurableObjectStorageSql {
    exec(query: string, ...params: unknown[]): DurableObjectStorageSqlResult;
    transactionSync?<T>(closure: () => T): T;
  }

  export interface DurableObjectStorageListResult {
    keys: Iterable<{ name: string }>;
  }

  export interface DurableObjectStorage {
    sql: DurableObjectStorageSql;
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string }): Promise<DurableObjectStorageListResult>;
    getAlarm(): Promise<number | null>;
    setAlarm(timeMs: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    transactionSync?<T>(closure: () => T): T;
  }

  export interface DurableObjectState {
    storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T>;
    acceptWebSocket(webSocket: WebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): WebSocket[];
    waitUntil?(promise: Promise<unknown>): void;
  }
}

interface WebSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};
