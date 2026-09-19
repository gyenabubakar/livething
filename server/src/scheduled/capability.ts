/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertValidLiveThingIdentifier } from '@livething/core';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { assertPositiveInteger } from '~/_engine/validation.ts';
import { makeScheduledPrimitive } from '~/scheduled/scheduled.ts';
import { scheduleSurfacePrimitive } from '~/scheduled/surface.ts';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { ScheduledOptions } from '~/scheduled/scheduled.ts';
import type { Validator } from '~/types.ts';

/** Retry policy for a scheduled task: default backoff, off, or a custom backoff array. */
type Retry = boolean | readonly number[];

/**
 * One scheduled-task declaration. A task either carries no payload (`null`),
 * recurs on an interval, carries a typed payload, or just sets a retry policy.
 * A recurring task cannot also carry a payload — it has no caller to supply one.
 */
export type ScheduledDef =
  | null
  | { readonly every: number; readonly retry?: Retry }
  | { readonly data: TypeMarker<any> | Validator; readonly retry?: Retry }
  | { readonly retry: Retry };

/** The map of task id → declaration passed to `scheduled(...)`. */
export type ScheduledDefs = Record<string, ScheduledDef>;

/** The payload type a single task declaration carries, or `undefined` for none. */
type DataOf<TDef> = TDef extends { data: infer D }
  ? D extends TypeMarker<infer U>
    ? U
    : D extends Validator<infer U>
      ? U
      : unknown
  : undefined;

/** The contract slot `scheduled(...)` declares — task id → payload type. */
type ScheduledSlot<TDefs extends ScheduledDefs> = {
  scheduled: { [K in keyof TDefs & string]: DataOf<TDefs[K]> };
};

/** The resolved, runtime form of one task declaration, consumed at assembly. */
export interface ScheduledDeclaration {
  readonly hasData: boolean;
  readonly dataSchema?: Validator;
  readonly options?: ScheduledOptions;
}

/** A `scheduled(...)` capability, carrying its declarations and primitive builder for assembly. */
export interface ScheduledCapability<
  TDefs extends ScheduledDefs = ScheduledDefs,
> extends Capability<ScheduledSlot<TDefs>, never, 'scheduled'> {
  /** Resolved task declarations, keyed by task id. @internal */
  readonly __scheduled: ReadonlyMap<string, ScheduledDeclaration>;
  /** Build a task primitive from a declaration and its body, so the core never imports it. @internal */
  readonly __buildScheduled: (
    taskId: string,
    declaration: ScheduledDeclaration,
    body: (ctx: any, data?: unknown) => void | Promise<void>,
  ) => Primitive;
}

/** A `t<T>()` marker carries a type only — there is no runtime validator on it. */
function isTypeMarker(value: unknown): value is TypeMarker<unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __livething_t?: unknown }).__livething_t === 't'
  );
}

function resolveDeclaration(taskId: string, def: ScheduledDef): ScheduledDeclaration {
  if (def === null) return { hasData: false };

  const context = `scheduled("${taskId}")`;

  const dataValue = 'data' in def ? def.data : undefined;
  const dataSchema =
    dataValue !== undefined && !isTypeMarker(dataValue) ? (dataValue as Validator) : undefined;

  if ('every' in def && def.every !== undefined) {
    assertPositiveInteger(def.every, '.every', context);
  }

  if ('retry' in def && def.retry !== undefined && Array.isArray(def.retry)) {
    if (def.retry.length === 0) {
      throw new Error(`[livething] ${context}: 'retry' requires at least one entry.`);
    }

    for (const entry of def.retry) {
      assertPositiveInteger(entry, '.retry', context);
    }
  }

  const options: ScheduledOptions = {};
  if ('every' in def && def.every !== undefined) (options as { every?: number }).every = def.every;
  if ('retry' in def && def.retry !== undefined) (options as { retry?: Retry }).retry = def.retry;
  const hasOptions = options.every !== undefined || options.retry !== undefined;

  return {
    hasData: 'data' in def,
    dataSchema,
    options: hasOptions ? options : undefined,
  };
}

/**
 * Declare the scheduled tasks this server runs, and enable `base.scheduled`
 * handlers and `ctx.schedule(...)`. Each key is a task id; the value declares
 * how it behaves. Bind a body for every declared task with `base.scheduled`.
 *
 * Task payloads are typed with `t<...>()` and trusted, not validated — they
 * originate on the server when you call `ctx.schedule(...)`.
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { scheduled } from '@livething/server/scheduled';
 *
 * const base = server({
 *   capabilities: [
 *     scheduled({
 *       cleanup: null,
 *       heartbeat: { every: 30_000 },
 *       report: { data: t<{ userId: string }>(), retry: true },
 *     }),
 *   ],
 * });
 *
 * base.scheduled('report', {
 *   run(ctx, data) {
 *     // data: { userId: string }
 *   },
 * });
 * ```
 */
export const scheduled = withCapabilityKind(function scheduled<const TDefs extends ScheduledDefs>(
  defs: TDefs,
): ScheduledCapability<TDefs> {
  const declarations = new Map<string, ScheduledDeclaration>();
  for (const [taskId, def] of Object.entries(defs)) {
    assertValidLiveThingIdentifier(taskId, 'scheduled() task id');
    declarations.set(taskId, resolveDeclaration(taskId, def));
  }

  const cap = capability<ScheduledSlot<TDefs>, never, 'scheduled'>([
    scheduleSurfacePrimitive(),
  ]) as ScheduledCapability<TDefs>;
  const writable = cap as {
    __scheduled: ReadonlyMap<string, ScheduledDeclaration>;
    __buildScheduled: ScheduledCapability['__buildScheduled'];
  };
  writable.__scheduled = declarations;

  writable.__buildScheduled = (taskId, declaration, body) =>
    makeScheduledPrimitive(taskId, declaration, body);

  return stampKind(cap, CAPABILITY_KIND.scheduled);
}, CAPABILITY_KIND.scheduled);
