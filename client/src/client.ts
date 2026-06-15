/* oxlint-disable @typescript-eslint/no-explicit-any -- merging primitive types needs `any` */
import { WSKitConfigError } from '@wskit/core';
import { WSKitSocket } from '~/socket/socket.ts';
import type { ConnectDescriptor } from '~/connect.ts';
import type { SocketConfig } from '~/internal/config.ts';
import type { PrimitiveRuntime } from '~/internal/runtime.ts';
import type {
  ApplyPrimitives,
  MissingPrimitiveStubs,
  Primitive,
  ValidatePrimitives,
} from '~/primitives/types.ts';
import type { Socket } from '~/socket/api.ts';
import type { SocketContract } from '~/types.ts';

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
    connectDescriptor: ConnectDescriptor,
    ...primitives: [...TPrimitives] & ValidatePrimitives<TContract, TPrimitives>
  ): Socket<TContract> &
    ApplyPrimitives<TPrimitives, TContract> &
    MissingPrimitiveStubs<TContract, TPrimitives> {
    return buildSocket(
      connectDescriptor,
      primitives as readonly Primitive[],
    ) as unknown as Socket<TContract> &
      ApplyPrimitives<TPrimitives, TContract> &
      MissingPrimitiveStubs<TContract, TPrimitives>;
  };
}

/** The actual assembly, with the types erased. */
function buildSocket(
  connectDescriptor: ConnectDescriptor,
  primitives: readonly Primitive[],
): WSKitSocket {
  const pluginSpecs = primitives.filter((spec) => spec._plugin !== undefined);
  const primitiveSpecs = [
    connectDescriptor,
    ...primitives.filter((spec) => spec._plugin === undefined),
  ];

  assertNoDuplicateTags(primitiveSpecs);
  assertUniquePluginIdentity(pluginSpecs);
  assertDependenciesPresent([...primitiveSpecs, ...pluginSpecs]);

  // Primitives run first, in dependency order; plugins run after, in
  // registration order. The socket walks this one list for every hook, so
  // "primitives before plugins" holds for onOpen/onIncoming/onOutgoing/onClose.
  const sorted = [...topoSort(primitiveSpecs), ...pluginSpecs];

  const config = {} as SocketConfig;
  for (const spec of sorted) spec.applyConfig?.(config);
  if (config.url === undefined) {
    throw new WSKitConfigError('[wskit] client() requires a connect() capability.');
  }

  const socket = new WSKitSocket(config);
  socket._setKnownTags(new Set(sorted.map((spec) => spec._tag).filter(Boolean)));
  const helpers = socket._helpers();

  const runtimes: PrimitiveRuntime[] = [];
  for (const spec of sorted) {
    if (spec.setup) runtimes.push(spec.setup(helpers));
  }

  socket._setPrimitives(runtimes);
  for (const runtime of runtimes) runtime.install?.(socket);

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

/**
 * Plugins are de-duplicated by `key` plus optional `registrationId`, not by
 * their human-readable `id`. Registering the same plugin twice (or two instances
 * with the same `registrationId`) throws. Two different plugins that share an
 * `id` only warn, since the `id` is just a log label.
 */
function assertUniquePluginIdentity(pluginSpecs: readonly Primitive[]): void {
  const registrationsByKey = new Map<symbol, Set<string | undefined>>();
  const keysById = new Map<string, Set<symbol>>();

  for (const spec of pluginSpecs) {
    const { key, id, registrationId } = spec._plugin!;

    let registrations = registrationsByKey.get(key);
    if (!registrations) {
      registrations = new Set();
      registrationsByKey.set(key, registrations);
    }
    if (registrations.has(registrationId)) {
      throw new WSKitConfigError(
        registrationId === undefined
          ? `[wskit] plugin '${id}' is registered more than once. Add a registrationId to allow multiple instances.`
          : `[wskit] plugin '${id}' is registered twice with the same registrationId '${registrationId}'.`,
      );
    }
    registrations.add(registrationId);

    let keys = keysById.get(id);
    if (!keys) {
      keys = new Set();
      keysById.set(id, keys);
    }
    keys.add(key);
    if (keys.size === 2) {
      console.warn(
        `[wskit] two different plugins share the id '${id}'. Ids show up in logs — consider a unique colon-form id.`,
      );
    }
  }
}

function assertDependenciesPresent(specs: readonly Primitive[]): void {
  const tags = new Set(specs.map((spec) => spec._tag));
  for (const spec of specs) {
    for (const dependency of spec.dependencies ?? []) {
      if (!tags.has(dependency)) {
        throw new WSKitConfigError(
          `[wskit] ${spec._tag} requires ${dependency}. Register ${dependency}() in client.`,
        );
      }
    }
  }
}

/**
 * Sort primitives so each one runs after the ones it depends on, plus any
 * `optionalAfter` ones that are present. Visits are tracked by object (not tag)
 * so repeatable primitives like `intercept`, which share a tag, are all kept.
 * Throws if dependencies form a cycle.
 */
function topoSort(specs: readonly Primitive[]): Primitive[] {
  const byTag = new Map<string, Primitive[]>();
  for (const spec of specs) {
    const group = byTag.get(spec._tag);
    if (group) group.push(spec);
    else byTag.set(spec._tag, [spec]);
  }
  const sorted: Primitive[] = [];
  const state = new Map<Primitive, 'visiting' | 'done'>();

  function visit(spec: Primitive): void {
    const status = state.get(spec);
    if (status === 'done') return;
    if (status === 'visiting') {
      throw new WSKitConfigError(`[wskit] circular primitive dependency detected at ${spec._tag}.`);
    }
    state.set(spec, 'visiting');
    for (const dependency of [...(spec.dependencies ?? []), ...(spec.optionalAfter ?? [])]) {
      for (const dependencySpec of byTag.get(dependency) ?? []) visit(dependencySpec);
    }
    state.set(spec, 'done');
    sorted.push(spec);
  }

  for (const spec of specs) visit(spec);
  return sorted;
}
