import type { AnyScheduled } from '~/_engine/compile/types.ts';
import type { StorageProvider, TimerProvider } from '~/context.ts';
import type { ScheduledDeadLetter, ScheduledRun } from '~/scheduled/types.ts';
import type { Validator } from '~/types.ts';

/**
 * The runtime registration surface built-in primitives receive during engine
 * initialization.
 *
 * Built-in primitives can use this to attach lifecycle hooks, message-pipeline
 * transforms, scoped channel hooks, and context extensions without getting the
 * full engine instance directly.
 */
export interface EngineAccess {
  /**
   * Install shared primitive runtime logic once.
   *
   * Use this when many instances of the same primitive may appear, but the
   * runtime behavior should only be wired into the engine a single time.
   */
  installOnce(key: symbol, install: () => void): void;

  /**
   * Run internal startup logic before normal server init begins.
   *
   * This is for framework-owned boot work like restoring state from storage.
   * Product-level startup belongs in `onInit`, not here.
   */
  onBoot(handler: () => void | Promise<void>): void;

  /**
   * Observe or rewrite incoming wire messages before the engine routes them.
   *
   * Return a new `{ event, payload }` object to replace the message, or return
   * nothing to leave it unchanged.
   */
  onIncoming(
    handler: (message: {
      event: string;
      payload: unknown;
    }) => { event: string; payload: unknown } | void,
  ): void;

  /**
   * Observe or rewrite outgoing wire messages before they are serialized.
   *
   * Return a new `{ event, payload }` object to replace the message, or return
   * nothing to keep the original message.
   */
  onOutgoing(
    handler: (message: {
      event: string;
      payload: unknown;
    }) => { event: string; payload: unknown } | void,
  ): void;

  /**
   * Run logic when the server finishes booting.
   *
   * This receives the same init-style context that user-facing `onInit`
   * handlers see.
   */
  onInit(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Run logic after one connection has been accepted and its context exists.
   */
  onConnect(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Run logic after one connection has closed.
   */
  onDisconnect(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Run logic while the engine is shutting down.
   */
  onShutdown(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Observe runtime errors.
   *
   * Returning `true` means "this error was handled, stop normal error
   * propagation."
   */
  onError(
    handler: (
      ctx: unknown,
      error: unknown,
      event?: string,
    ) => boolean | void | Promise<boolean | void>,
  ): void;

  /**
   * Decide whether an upgrade request should be accepted.
   *
   * Use this to attach tags or metadata, or to reject the upgrade earlier than
   * normal connection setup.
   */
  onUpgrade(
    handler: (request: Request) =>
      | { meta?: Record<string, unknown>; tags?: readonly string[] }
      | Promise<{
          meta?: Record<string, unknown>;
          tags?: readonly string[];
        }>,
  ): void;

  /**
   * Observe binary websocket messages.
   */
  onBinary(handler: (ctx: unknown, data: ArrayBuffer) => void | Promise<void>): void;

  /**
   * Observe validation failures for incoming payloads.
   */
  onValidationError(
    handler: (ctx: unknown, event: string, validationError: unknown) => void | Promise<void>,
  ): void;

  /**
   * Run logic when the adapter wakes the engine for an alarm.
   *
   * Scheduled tasks use this to process due work.
   */
  onAlarm(handler: () => void | Promise<void>): void;

  /**
   * Run logic before a channel subscription completes.
   *
   * The optional validator lets the primitive validate subscription data before
   * the hook receives it.
   */
  onBeforeSubscribe(
    handler: (ctx: unknown, data?: unknown) => void | Promise<void>,
    validator?: Validator<unknown>,
  ): void;

  /**
   * Run logic after a channel subscription succeeds.
   */
  onSubscribe(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Run logic after a channel unsubscription finishes.
   */
  onUnsubscribe(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Add extra fields or methods to every live connection context.
   */
  extendContext(factory: (baseCtx: unknown) => Record<string, unknown>): void;

  /**
   * Read the adapter storage dependency.
   *
   * This throws if the current adapter did not provide storage.
   */
  requireStorage(): StorageProvider;

  /**
   * Read the adapter timer dependency.
   *
   * This throws if the current adapter did not provide timers.
   */
  requireTimers(): TimerProvider;

  /**
   * Access the engine's in-memory table of queued scheduled runs.
   */
  getScheduledRuns(): Map<string, ScheduledRun>;

  /**
   * Access the engine's in-memory dead-letter queue for scheduled runs.
   */
  getScheduledDlq(): Map<string, ScheduledDeadLetter>;

  /**
   * Look up one declared scheduled task by task id.
   */
  getScheduledTask(taskId: string): AnyScheduled | undefined;

  /**
   * Read every declared scheduled task.
   */
  getScheduledTasks(): Iterable<AnyScheduled>;

  /**
   * Build the runtime task context object used when scheduled work runs.
   *
   * It is returned as `unknown` here on purpose so primitive setup code does
   * not depend on a concrete engine context type.
   */
  createTaskContext(): unknown;

  /**
   * Recompute the next alarm from the current scheduled-run table.
   */
  rescheduleAlarm(): void;

  /**
   * Create a framework-generated id.
   *
   * This is usually used for tasks, acks, streams, or other internal runtime
   * bookkeeping.
   */
  generateId(prefix?: string): string;

  /**
   * Send one raw protocol event directly to a live connection by id.
   *
   * This bypasses the normal typed ctx helpers.
   */
  rawSend(connectionId: string, event: string, payload: unknown): void;
}
