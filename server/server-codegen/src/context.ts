/* oxlint-disable @typescript-eslint/no-explicit-any */
export interface SqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown> | null;
  raw(): unknown[][];
}

export interface SQLProvider {
  exec(query: string, ...params: unknown[]): SqlResult;
  transaction<T>(fn: (tx: { exec(query: string, ...params: unknown[]): SqlResult }) => T): T;
}

export interface KVProvider {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface StorageProvider {
  sql: SQLProvider;
  kv: KVProvider;
}

export interface TimerProvider {
  setAlarm?(timeMs: number): Promise<void>;
  deleteAlarm?(): Promise<void>;
  getAlarm?(): Promise<number | null>;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface ConnectionInfo<Meta = Record<string, unknown>> {
  readonly id: string;
  readonly meta: Meta;
  readonly tags: readonly string[];
  readonly channels: readonly string[];
  readonly latency: number | null;
  readonly quality: 'excellent' | 'good' | 'degraded' | 'poor';
  readonly bufferedAmount: number;
}

export interface BroadcastOptions {
  readonly channel?: string;
  readonly excludeSelf?: boolean;
}

export interface ScopeSendApi {
  readonly name: string;
  send(event: string, payload: unknown): boolean;
  broadcast(event: string, payload: unknown): void;
}

export interface ReplayScopeSendApi extends ScopeSendApi {
  // This stays optional in the broad runtime type because not every channel
  // context has replay enabled. The precise generated/app-facing types narrow
  // this to required only when replay() is actually registered for that scope.
  sendReplay?(
    event: string,
    payload: unknown,
    wire: { seq: number; messageId: string; channel?: string },
  ): void;
}

export interface ChannelManager<Meta = Record<string, unknown>> {
  members(name: string): ConnectionInfo<Meta>[];
  kick(channelName: string, tag: string, reason: string): void;
}

export interface ConnectionContext<
  Env = Record<string, unknown>,
  Meta = Record<string, unknown>,
  Platform = unknown,
> {
  id: string;
  meta: Meta;
  tags: readonly string[];
  tag(label: string): void;
  untag(label: string): void;

  send(event: string, payload: unknown): boolean;
  broadcast(event: string, payload: unknown, options?: BroadcastOptions): void;
  sendTo(tag: string, event: string, payload: unknown): void;
  sendToConnection(connectionId: string, event: string, payload: unknown): boolean;

  sendBinary(data: ArrayBuffer | ArrayBufferView): boolean;
  broadcastBinary(data: ArrayBuffer | ArrayBufferView, options?: { excludeSelf?: boolean }): void;

  close(code?: number, reason?: string): void;
  getConnections(): ConnectionInfo<Meta>[];
  getConnectionsByTag(tag: string): ConnectionInfo<Meta>[];
  connectionCount: number;
  bufferedAmount: number;
  latency: number | null;
  quality: 'excellent' | 'good' | 'degraded' | 'poor';

  namespace?: ScopeSendApi;
  channel?: ReplayScopeSendApi;
  channels: ChannelManager<Meta>;

  schedule(taskId: string, options: { time: number; data?: unknown }): void;
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;
  setAlarm(time: number): void;

  sql: SQLProvider;
  kv: KVProvider;
  env: Env;
  log: Logger;
  waitUntil(promise: Promise<unknown>): void;
  platform: Platform;
}

export interface InitContext<Env = Record<string, unknown>, Platform = unknown> {
  sql: SQLProvider;
  kv: KVProvider;
  env: Env;
  log: Logger;
  platform: Platform;
}

export interface ShutdownContext<
  Env = Record<string, unknown>,
  Meta = Record<string, unknown>,
  Platform = unknown,
> {
  closeAll(code?: number, reason?: string): void;
  broadcast(event: string, payload: unknown, options?: { channel?: string }): void;
  sql: SQLProvider;
  kv: KVProvider;
  schedule(taskId: string, options: { time: number; data?: unknown }): void;
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;
  connectionCount: number;
  getConnections(): ConnectionInfo<Meta>[];
  getConnectionsByTag(tag: string): ConnectionInfo<Meta>[];
  env: Env;
  log: Logger;
  waitUntil(promise: Promise<unknown>): void;
  platform: Platform;
}

export interface TaskContext<
  Env = Record<string, unknown>,
  Meta = Record<string, unknown>,
  Platform = unknown,
> {
  sql: SQLProvider;
  kv: KVProvider;
  broadcast(event: string, payload: unknown, options?: { channel?: string }): void;
  sendTo(tag: string, event: string, payload: unknown): void;
  sendToConnection(connectionId: string, event: string, payload: unknown): boolean;
  getConnections(): ConnectionInfo<Meta>[];
  getConnectionsByTag(tag: string): ConnectionInfo<Meta>[];
  connectionCount: number;
  schedule(taskId: string, options: { time: number; data?: unknown }): void;
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;
  env: Env;
  log: Logger;
  waitUntil(promise: Promise<unknown>): void;
  platform: Platform;
}
