import type { Validator } from '../types.ts';

/**
 * The runtime registration surface built-in primitives receive during engine
 * initialization.
 *
 * Built-in primitives can use this to attach lifecycle hooks, message-pipeline
 * transforms, scoped channel hooks, and context extensions without getting the
 * full engine instance directly.
 */
export interface EngineAccess {
  onIncoming(
    handler: (message: {
      event: string;
      payload: unknown;
    }) => { event: string; payload: unknown } | void,
  ): void;
  onOutgoing(
    handler: (message: {
      event: string;
      payload: unknown;
    }) => { event: string; payload: unknown } | void,
  ): void;
  onInit(handler: (ctx: unknown) => void | Promise<void>): void;
  onConnect(handler: (ctx: unknown) => void | Promise<void>): void;
  onDisconnect(handler: (ctx: unknown) => void | Promise<void>): void;
  onShutdown(handler: (ctx: unknown) => void | Promise<void>): void;
  onError(
    handler: (
      ctx: unknown,
      error: unknown,
      event?: string,
    ) => boolean | void | Promise<boolean | void>,
  ): void;
  onUpgrade(
    handler: (request: Request) =>
      | { meta?: Record<string, unknown>; tags?: readonly string[] }
      | Promise<{
          meta?: Record<string, unknown>;
          tags?: readonly string[];
        }>,
  ): void;
  onBinary(handler: (ctx: unknown, data: ArrayBuffer) => void | Promise<void>): void;
  onValidationError(
    handler: (ctx: unknown, event: string, validationError: unknown) => void | Promise<void>,
  ): void;
  onBeforeSubscribe(
    handler: (ctx: unknown, data?: unknown) => void | Promise<void>,
    validator?: Validator<unknown>,
  ): void;
  onSubscribe(handler: (ctx: unknown) => void | Promise<void>): void;
  onUnsubscribe(handler: (ctx: unknown) => void | Promise<void>): void;
  extendContext(factory: (baseCtx: unknown) => Record<string, unknown>): void;
  generateId(prefix?: string): string;
  rawSend(connectionId: string, event: string, payload: unknown): void;
}
