import type * as EngineModule from '~/_engine/engine.ts';

/**
 * The low-level send/close callbacks an adapter provides for each WebSocket.
 *
 * When you build a custom platform adapter, you create one of these for every
 * accepted connection so the engine can push data to the client.
 */
export interface ConnectionDescriptor {
  send(data: string): void;
  sendBinary(data: ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  bufferedAmount(): number;
  meta?: Record<string, unknown>;
  tags?: readonly string[];
}

/**
 * Callbacks the engine returns after accepting a connection.
 *
 * The adapter calls these when the underlying WebSocket receives a message,
 * closes, or encounters an error.
 */
export interface ConnectionHandle {
  handleMessage(data: string): Promise<void>;
  handleBinary(data: ArrayBuffer): Promise<void>;
  handleClose(code: number, reason: string): Promise<void>;
  handleError(error: unknown): Promise<void>;
}

/**
 * The result of the `onUpgrade` hook — tells the adapter whether to accept or
 * reject the WebSocket upgrade request, along with any initial metadata and tags.
 */
export interface UpgradeDecision {
  reject?: boolean;
  code?: number;
  reason?: string;
  meta?: Record<string, unknown>;
  tags?: readonly string[];
}

/** Configuration the adapter passes when creating an engine instance. */
export interface EngineOptions {
  adapterId: string;
  hibernation: boolean;
}

/** The runtime engine created by the adapter from a compiled server definition. Handles connections, message routing, and lifecycle. */
export type Engine = EngineModule.Engine;

/**
 * The configuration object returned by `defineServerAdapter`.
 *
 * Platform adapters (like the Cloudflare adapter) use this to wire up the
 * engine to the platform's WebSocket lifecycle.
 */
export interface AdapterConfig<TOptions, TService> {
  id: string;
  hibernation: boolean | ((options: TOptions) => boolean);
  setup(createEngine: () => Engine, options: TOptions): TService;
}
