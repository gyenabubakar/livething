/* oxlint-disable @typescript-eslint/no-explicit-any -- merging primitive types needs `any` */
import { LiveThingConfigError } from '@livething/core';
import { LiveThingSocket } from '~/socket/socket.ts';
import type { ConnectDescriptor } from '~/connect.ts';
import type { SocketConfig } from '~/internal/config.ts';
import type { PrimitiveRuntime } from '~/internal/runtime.ts';
import type { TopLevelContract } from '~/plugins/contract.ts';
import type {
  ApplyPrimitives,
  Primitive,
  ValidatePrimitives,
  WithChannelPrimitiveSurface,
  WithMissingPrimitiveStubs,
} from '~/primitives/types.ts';
import type { Socket } from '~/socket/api.ts';
import type { SocketContract } from '~/types.ts';

/**
 * Assert a stripped contract still satisfies `SocketContract`. For a concrete
 * contract this is identity (no widening), so `on`/`send` stay strict; it only
 * exists to satisfy `Socket`'s constraint for a still-generic contract.
 */
type AsSocketContract<T> = T extends SocketContract ? T : SocketContract;

/**
 * The plugin ids claimed by the registered primitives — a plugin carries its id
 * as a literal on `_plugin`. A non-plugin primitive contributes `never`, so this
 * is the union of just the claimed namespaces.
 */
type ClaimedIds<TPrimitives extends readonly unknown[]> = {
  [I in keyof TPrimitives]: TPrimitives[I] extends {
    readonly _plugin: { readonly id: infer TId extends string };
  }
    ? TId
    : never;
}[number];

type AppSocketFor<
  C,
  TPrimitives extends readonly Primitive<any, any>[],
> = WithMissingPrimitiveStubs<
  WithChannelPrimitiveSurface<
    Socket<AsSocketContract<C>> & ApplyPrimitives<TPrimitives, C>,
    C,
    TPrimitives
  >,
  C,
  TPrimitives
>;

/**
 * The app socket type, built over the contract with every *claimed* plugin name
 * removed (see {@link TopLevelContract}). A claimed name is reachable only through
 * its plugin's API; an unclaimed prefix stays on the top-level socket. The strip
 * is applied once here so the inner helpers don't recompute it.
 */
export type AppSocket<
  TContract extends SocketContract,
  TPrimitives extends readonly Primitive<any, any>[],
> = AppSocketFor<TopLevelContract<TContract, ClaimedIds<TPrimitives>>, TPrimitives>;

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
  ): AppSocket<TContract, TPrimitives> {
    return buildSocket(
      connectDescriptor,
      primitives as readonly Primitive[],
    ) as unknown as AppSocket<TContract, TPrimitives>;
  };
}

/** The actual assembly, with the types erased. */
function buildSocket(
  connectDescriptor: ConnectDescriptor,
  primitives: readonly Primitive[],
): LiveThingSocket {
  const pluginSpecs = primitives.filter((spec) => spec._plugin !== undefined);
  const primitiveSpecs = [
    connectDescriptor,
    ...primitives.filter((spec) => spec._plugin === undefined),
  ];

  assertNoDuplicateTags(primitiveSpecs);
  assertUniquePluginIds(pluginSpecs);
  assertDependenciesPresent([...primitiveSpecs, ...pluginSpecs]);

  // Primitives run first, in dependency order; plugins run after, in
  // registration order. The socket walks this one list for every hook, so
  // "primitives before plugins" holds for onOpen/onIncoming/onOutgoing/onClose.
  const sorted = [...topoSort(primitiveSpecs), ...pluginSpecs];

  const config = {} as SocketConfig;
  for (const spec of sorted) spec.applyConfig?.(config);
  if (config.url === undefined) {
    throw new LiveThingConfigError('client() requires a connect() capability.');
  }

  const socket = new LiveThingSocket(config);
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
      throw new LiveThingConfigError(
        `duplicate ${spec._tag}() — register each primitive at most once.`,
      );
    }

    seen.add(spec._tag);
  }
}

/**
 * A plugin's `id` is the namespace it owns on the wire, so no two plugins on one
 * socket may share it. Registering the same plugin (or any two plugins with the
 * same id) twice throws.
 */
function assertUniquePluginIds(pluginSpecs: readonly Primitive[]): void {
  const seen = new Set<string>();
  for (const spec of pluginSpecs) {
    const { id } = spec._plugin!;
    if (seen.has(id)) {
      throw new LiveThingConfigError(
        `plugin '${id}' is registered more than once. Each plugin id owns a namespace and must be unique.`,
      );
    }

    seen.add(id);
  }
}

function assertDependenciesPresent(specs: readonly Primitive[]): void {
  const tags = new Set(specs.map((spec) => spec._tag));
  for (const spec of specs) {
    for (const dependency of spec.dependencies ?? []) {
      if (!tags.has(dependency)) {
        throw new LiveThingConfigError(
          `${spec._tag} requires ${dependency}. Register ${dependency}() in client.`,
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
      throw new LiveThingConfigError(`circular primitive dependency detected at ${spec._tag}.`);
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
