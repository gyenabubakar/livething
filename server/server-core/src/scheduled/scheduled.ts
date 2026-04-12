/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EngineAccess } from '~/_engine/access.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';
import { bootstrapScheduledRuntime, handleScheduledAlarm } from './runtime.ts';
import type { ScheduledRuntimeAccess } from './types.ts';

export interface ScheduledOptions<TData = unknown> {
  readonly data?: Validator<TData>;
  readonly every?: number;
  readonly retry?: boolean;
}

export interface ScheduledHandle<TData = unknown> {
  readonly id: string;
  readonly __data?: TData;
}

export type ScheduledHandler<TCtx = any, TData = unknown> = (
  ctx: TCtx,
  data: TData,
) => void | Promise<void>;

export interface ScheduledPrimitive<
  TTaskId extends string = string,
  TData = unknown,
  TCtx = any,
> extends Primitive<'scheduled'> {
  readonly taskId: TTaskId;
  readonly handler?: ScheduledHandler<TCtx, TData>;
  readonly dataSchema?: Validator<TData>;
  readonly options?: ScheduledOptions<TData>;
}

const SCHEDULED_KEY = Symbol('scheduled');
const SCHEDULED_RUNTIME_KEY = Symbol('scheduled-runtime');

export function scheduled<TTaskId extends string, TData, TCtx>(
  taskId: TTaskId,
  handler: ScheduledHandler<TCtx, TData>,
  options?: ScheduledOptions<TData>,
): ScheduledPrimitive<TTaskId, TData, TCtx>;
export function scheduled<TTaskId extends string, TData>(
  taskId: TTaskId,
  dataSchema: Validator<TData>,
  options?: ScheduledOptions<TData>,
): ScheduledPrimitive<TTaskId, TData>;
export function scheduled(
  taskId: string,
  handlerOrSchema: ScheduledHandler | Validator,
  options?: ScheduledOptions,
): ScheduledPrimitive {
  const isHandler =
    typeof handlerOrSchema === 'function' && !('~standard' in (handlerOrSchema as object));

  return {
    __wskit: 'scheduled',
    __kind: 'infrastructure',
    __identity: [SCHEDULED_KEY, taskId],
    __dependencies: [],
    __requires: { storage: true, timers: true },
    taskId,
    handler: isHandler ? (handlerOrSchema as ScheduledHandler) : undefined,
    dataSchema: isHandler ? options?.data : (handlerOrSchema as Validator),
    options,
    __setup(engine: EngineAccess) {
      engine.installOnce(SCHEDULED_RUNTIME_KEY, () => {
        const runtime: ScheduledRuntimeAccess = {
          requireStorage: () => engine.requireStorage(),
          requireTimers: () => engine.requireTimers(),
          generateId: (prefix?: string) => engine.generateId(prefix),
          getScheduledRuns: () => engine.getScheduledRuns(),
          getScheduledDlq: () => engine.getScheduledDlq(),
          getScheduledTask: (taskId: string) => engine.getScheduledTask(taskId),
          getScheduledTasks: () => engine.getScheduledTasks(),
          createTaskContext: () => engine.createTaskContext(),
          rescheduleAlarm: () => engine.rescheduleAlarm(),
        };

        engine.onBoot(() => {
          bootstrapScheduledRuntime(runtime);
        });

        engine.onAlarm(async () => {
          await handleScheduledAlarm(runtime);
        });
      });
    },
  };
}

scheduled.__key = SCHEDULED_KEY;
