/* oxlint-disable @typescript-eslint/no-explicit-any -- merging primitive types needs `any` */
import { WSKitConfigError } from '@wskit/core';
import { WSKitSocket } from '~/socket/socket.ts';
import type { ConnectDescriptor } from '~/connect.ts';
import type { SocketConfig } from '~/internal/config.ts';
import type { PrimitiveRuntime } from '~/internal/runtime.ts';
import type { ApplyPrimitives, Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { Socket } from '~/socket/api.ts';
import type { Simplify, SocketContract } from '~/types.ts';

/**
 * Build a typed socket. You call it in two steps: first pick the contract, then
 * pass `connect(...)` and the primitives you want.
 *
 * ```ts
 * const socket = client<MySocket>()(
 *   connect('wss://example.com/ws'),
 *   reconnection({ maxAttempts: Infinity }),
 *   channels(),
 * );
 * ```
 *
 * Why two steps? TypeScript can't infer some type arguments while you spell out
 * others. Writing the contract in the first call frees the second call to infer
 * the primitives — that's what lets `socket.channel(...)` get typed from your
 * contract. The order of primitives doesn't matter; they're sorted by their
 * dependencies and checked against the contract.
 */
export function client<TContract extends SocketContract = SocketContract>() {
  return function build<const TPrimitives extends readonly Primitive<any, any>[] = []>(
    connectCap: ConnectDescriptor,
    ...primitives: [...TPrimitives] & ValidatePrimitives<TContract, TPrimitives>
  ): Simplify<Socket<TContract> & ApplyPrimitives<TPrimitives, TContract>> {
    return buildSocket(connectCap, primitives as readonly Primitive[]) as unknown as Simplify<
      Socket<TContract> & ApplyPrimitives<TPrimitives, TContract>
    >;
  };
}

/** The actual assembly, with the types erased. */
function buildSocket(connectCap: ConnectDescriptor, primitives: readonly Primitive[]): WSKitSocket {
  const specs = [connectCap, ...primitives];
  assertNoDuplicateTags(specs);
  assertDependenciesPresent(specs);
  const sorted = topoSort(specs);

  // Each primitive copies its settings into one shared config object.
  const config = {} as SocketConfig;
  for (const spec of sorted) spec.applyConfig?.(config);
  if (config.url === undefined) {
    throw new WSKitConfigError('[wskit] client() requires a connect() capability.');
  }

  // Build the engine first so each primitive's setup() can safely use it.
  const socket = new WSKitSocket(config);
  const helpers = socket._helpers();

  const runtimes: PrimitiveRuntime[] = [];
  for (const spec of sorted) {
    if (spec.setup) runtimes.push(spec.setup(helpers));
  }

  socket._setPrimitives(runtimes);
  for (const runtime of runtimes) runtime.install?.(socket as unknown as Record<string, unknown>);

  return socket;
}

/** Tags allowed more than once — each call adds to the others instead of clashing. */
const REPEATABLE_TAGS = new Set(['intercept']);

function assertNoDuplicateTags(specs: readonly Primitive[]): void {
  const seen = new Set<string>();
  for (const spec of specs) {
    if (REPEATABLE_TAGS.has(spec._tag)) continue;
    if (seen.has(spec._tag)) {
      throw new WSKitConfigError(
        `[wskit] duplicate ${spec._tag}() — register each primitive at most once.`,
      );
    }
    seen.add(spec._tag);
  }
}

function assertDependenciesPresent(specs: readonly Primitive[]): void {
  const tags = new Set(specs.map((s) => s._tag));
  for (const spec of specs) {
    for (const dep of spec.dependencies ?? []) {
      if (!tags.has(dep)) {
        throw new WSKitConfigError(
          `[wskit] ${spec._tag} requires ${dep}. Register ${dep}() in client.`,
        );
      }
    }
  }
}

/**
 * Order the primitives so each one runs after the primitives it depends on.
 * We track visits by the object itself (not its tag) so repeatable primitives
 * like `intercept`, which share a tag, are all kept. Throws if deps form a loop.
 */
function topoSort(specs: readonly Primitive[]): Primitive[] {
  const byTag = new Map(specs.map((s) => [s._tag, s]));
  const sorted: Primitive[] = [];
  const state = new Map<Primitive, 'visiting' | 'done'>();

  function visit(spec: Primitive): void {
    const status = state.get(spec);
    if (status === 'done') return;
    if (status === 'visiting') {
      throw new WSKitConfigError(`[wskit] circular primitive dependency detected at ${spec._tag}.`);
    }
    state.set(spec, 'visiting');
    for (const dep of spec.dependencies ?? []) {
      const depSpec = byTag.get(dep);
      if (depSpec) visit(depSpec);
    }
    state.set(spec, 'done');
    sorted.push(spec);
  }

  for (const spec of specs) visit(spec);
  return sorted;
}
