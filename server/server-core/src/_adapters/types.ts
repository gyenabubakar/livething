import type * as EngineModule from '~/_engine/engine.ts';
import type * as DefineServer from '~/server-definition.ts';

export interface ConnectionDescriptor {
  send(data: string): void;
  sendBinary(data: ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  bufferedAmount(): number;
  meta?: Record<string, unknown>;
  tags?: readonly string[];
}

export interface ConnectionHandle {
  handleMessage(data: string): Promise<void>;
  handleBinary(data: ArrayBuffer): Promise<void>;
  handleClose(code: number, reason: string): Promise<void>;
  handleError(error: unknown): Promise<void>;
}

export interface UpgradeDecision {
  reject?: boolean;
  code?: number;
  reason?: string;
  meta?: Record<string, unknown>;
  tags?: readonly string[];
}

export interface EngineOptions {
  adapterId: string;
  hibernation: boolean;
}

export type Engine = EngineModule.Engine;
export type ServerDefinition = DefineServer.ServerDefinition;

export interface AdapterConfig<TOptions, TService> {
  id: string;
  hibernation: boolean;
  setup(
    handler: ServerDefinition,
    createEngine: () => Engine,
    options: TOptions,
  ): TService;
}
