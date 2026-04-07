import type { ServerDefinition } from '../../define-server.ts';
import type { Engine } from '../engine.ts';

/**
 * Minimal websocket-like handle the engine can write to.
 *
 * Adapters wrap their platform socket or session object in this shape so the
 * engine can stay platform-agnostic.
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
 * Callbacks the adapter uses to push connection events into the engine.
 */
export interface ConnectionHandle {
  handleMessage(data: string): void;
  handleBinary(data: ArrayBuffer): void;
  handleClose(code: number, reason: string): void;
  handleError(error: unknown): void;
}

/**
 * Result of running the optional upgrade hook before a websocket is accepted.
 */
export interface UpgradeDecision {
  reject?: boolean;
  code?: number;
  reason?: string;
  meta?: Record<string, unknown>;
  tags?: readonly string[];
}

/**
 * Small adapter capability snapshot given to the engine at construction time.
 */
export interface EngineOptions {
  adapterId: string;
  hibernation: boolean;
}

/**
 * Public contract for a platform adapter.
 *
 * `setup()` receives a ready engine and can return any platform-specific server
 * object or service wrapper it wants.
 */
export interface AdapterConfig<TOptions, TService> {
  id: string;
  hibernation: boolean;
  setup(handler: ServerDefinition, engine: Engine, options: TOptions): TService | Promise<TService>;
}
