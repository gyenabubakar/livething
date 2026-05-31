/* oxlint-disable @typescript-eslint/no-explicit-any -- primitive type merging requires `any` */
import { WSKitConfigError } from '@wskit/core';
import { SocketImpl } from '~/socket/socket.ts';
import type { ConnectDescriptor } from '~/connect.ts';
import type { SocketConfig } from '~/internal/config.ts';
import type { PrimitiveHelpers, PrimitiveRuntime, WireMessage } from '~/internal/runtime.ts';
import type {
  ApplyPrimitives,
  PrimitiveDescriptor,
  PrimitiveSpec,
  ValidatePrimitives,
} from '~/primitives/types.ts';
import type { Socket } from '~/socket/api.ts';
import type { Simplify, SocketContract } from '~/types.ts';

/**
 * Create a typed WebSocket client. Curried: fix the contract first, then pass a
 * `connect()` capability and a flat list of primitives. The second call infers
 * the primitives — deduplicated by tag, auto-sorted by dependency, and
 * validated against each other and the contract. Order does not matter.
 *
 * The curry is required: TypeScript has no partial type-argument inference, so
 * an explicit contract on a single call would disable inference of the
 * primitives tuple. Fixing the contract in the first call lets the second infer
 * everything.
 *
 * ```ts
 * const socket = client<MySocket>()(
 *   connect('wss://example.com/ws'),
 *   reconnection({ maxAttempts: Infinity }),
 *   channels(),
 * );
 * ```
 */
export function client<TContract extends SocketContract = SocketContract>() {
  return function build<const TPrimitives extends readonly PrimitiveDescriptor<any, any>[] = []>(
    connectCap: ConnectDescriptor,
    ...primitives: [...TPrimitives] & ValidatePrimitives<TContract, TPrimitives>
  ): Simplify<Socket<TContract> & ApplyPrimitives<TPrimitives, TContract>> {
    return buildSocket(connectCap, primitives as readonly PrimitiveSpec[]) as unknown as Simplify<
      Socket<TContract> & ApplyPrimitives<TPrimitives, TContract>
    >;
  };
}

/** Shared runtime assembly, independent of the contract/primitive generics. */
function buildSocket(
  connectCap: ConnectDescriptor,
  primitives: readonly PrimitiveSpec[],
): SocketImpl {
  const specs = [connectCap, ...primitives];
  assertNoDuplicateTags(specs);
  assertDependenciesPresent(specs);
  const sorted = topoSort(specs);

  // Build the resolved config bag from each primitive's contribution.
  const config = {} as SocketConfig;
  for (const spec of sorted) spec.applyConfig?.(config);
  if (config.url === undefined) {
    throw new WSKitConfigError('[wskit] client() requires a connect() capability.');
  }

  // `socket` is assigned right after construction, before any helper runs.
  let socket: SocketImpl;
  let idCounter = 0;
  const helpers: PrimitiveHelpers = {
    rawSend: (message: WireMessage) => socket._rawSend(message),
    send: (message: WireMessage, options?: { ttl?: number }) => socket._send(message, options),
    generateId: (prefix?: string) => {
      const id = ++idCounter;
      return prefix ? `${prefix}-${id}` : `${id}`;
    },
    getState: () => socket.getState(),
    ensureConnected: () => socket._ensureConnected(),
    lazyAcquire: () => socket._lazyAcquire(),
    lazyRelease: () => socket._lazyRelease(),
  };

  const runtimes: PrimitiveRuntime[] = [];
  for (const spec of sorted) {
    if (spec.setup) runtimes.push(spec.setup(helpers));
  }

  socket = new SocketImpl(config, runtimes);
  for (const runtime of runtimes) runtime.install?.(socket as unknown as Record<string, unknown>);

  return socket;
}

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

function assertNoDuplicateTags(specs: readonly PrimitiveSpec[]): void {
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec._tag)) {
      throw new WSKitConfigError(
        `[wskit] duplicate ${spec._tag}() — register each primitive at most once.`,
      );
    }
    seen.add(spec._tag);
  }
}

function assertDependenciesPresent(specs: readonly PrimitiveSpec[]): void {
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

/** Topologically sort by `dependencies` (deps run before dependents). Throws on cycles. */
function topoSort(specs: readonly PrimitiveSpec[]): PrimitiveSpec[] {
  const byTag = new Map(specs.map((s) => [s._tag, s]));
  const sorted: PrimitiveSpec[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  function visit(spec: PrimitiveSpec): void {
    const status = state.get(spec._tag);
    if (status === 'done') return;
    if (status === 'visiting') {
      throw new WSKitConfigError(`[wskit] circular primitive dependency detected at ${spec._tag}.`);
    }
    state.set(spec._tag, 'visiting');
    for (const dep of spec.dependencies ?? []) {
      const depSpec = byTag.get(dep);
      if (depSpec) visit(depSpec);
    }
    state.set(spec._tag, 'done');
    sorted.push(spec);
  }

  for (const spec of specs) visit(spec);
  return sorted;
}
