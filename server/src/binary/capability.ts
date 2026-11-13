import { assertValidLiveThingIdentifier, WIRE_LIMITS } from '@livething/core';
import { assertConfigShape } from '~/_define/capability-checks.ts';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { outgoing as outgoingFactory } from '~/outgoing/outgoing.ts';
import { definePrimitive } from '~/primitive.ts';
import type { Capability } from '~/_define/capability.ts';
import type { EmitDefs, EmitSlot } from '~/emits/emits.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerRequestDeclaration, ServerRequestsSlot } from '~/request/server-requests.ts';
import { addBinarySenders, processBinaryMessage } from './runtime.ts';

/** The binary server requests one `binary({ serverRequests })` declares. */
type BinaryServerRequestDefs = Record<string, ServerRequestDeclaration>;

/** What `binary({...})` declares for one scope. */
export interface BinaryDeclarations<
  TEmits extends EmitDefs = EmitDefs,
  TRequests extends BinaryServerRequestDefs = BinaryServerRequestDefs,
> {
  /**
   * The binary events this scope sends, as `name: t<Info>()`. The marker types the info,
   * which is JSON (a plain object or `null`). The bytes are not typed: they can be anything.
   */
  readonly emits?: TEmits;
  /**
   * The binary requests the server sends to a client, as `name: { out, in }`. `out` types the
   * info the server sends, and the `in` schema checks the info of the client's binary answer.
   * Sent with `ctx.binary.request(...)`, which needs `serverRequests()` too.
   */
  readonly serverRequests?: TRequests;
}

/**
 * The contract slots `binary({...})` declares: the binary events the client receives, and the
 * binary requests the server sends.
 */
export type BinarySlot<TEmits extends EmitDefs, TRequests extends BinaryServerRequestDefs = {}> = {
  binaryOutgoing: EmitSlot<TEmits>['outgoing'];
  binaryServerRequests: ServerRequestsSlot<TRequests>['serverRequests'];
};

/**
 * The value `binary({...})` returns. List it in `server({ capabilities })` to turn binary
 * messages on, and in a channel's own `capabilities` for that channel's binary events.
 */
export type BinaryCapability<
  TEmits extends EmitDefs = {},
  TRequests extends BinaryServerRequestDefs = {},
> = Capability<BinarySlot<TEmits, TRequests>, never, 'binary'> & {
  /** The declared binary events, read by the channel types. @internal */
  readonly __channelBinaryEmits: TEmits;
  /** The binary event primitives, which a channel puts in its own scope. @internal */
  readonly __binaryOutgoing: readonly Primitive[];
  /** The declared binary server requests. `assemble()` puts them in the request table. @internal */
  readonly __binaryServerRequests: TRequests;
};

const BINARY_RUNTIME_KEY = Symbol('binary-runtime');

/** Fills the engine's binary slot: the receive path and the `.binary` senders. */
const binaryRuntime = definePrimitive({
  tag: 'binary-runtime',
  key: BINARY_RUNTIME_KEY,
  setup(engine) {
    engine.setBinaryService({ dispatch: processBinaryMessage, addSenders: addBinarySenders });
  },
});

const BINARY_CONFIG = { hooks: [], options: ['emits', 'serverRequests'] };

/**
 * Turn binary messages on. A binary message carries JSON **info**, typed like any payload,
 * and raw **bytes** that no schema checks. List `binary()` at the root to accept binary
 * frames and get `base.binary.on(...)`, `base.binary.request(...)`, `base.binary.stream(...)`
 * and the `.binary` senders. Without it, a binary frame closes the socket with `1003`.
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { binary } from '@livething/server/binary';
 *
 * const base = server({
 *   capabilities: [binary({ emits: { 'avatar-preview': t<null>() } })],
 * });
 *
 * export const handleUploadAvatar = base.binary.on('upload-avatar', {
 *   maxBytes: 2 * 1024 * 1024,
 *   run(ctx, _input, bytes) {
 *     ctx.binary.send('avatar-preview', null, bytes);
 *   },
 * });
 * ```
 */
export const binary = withCapabilityKind(function binary<
  const TEmits extends EmitDefs = {},
  const TRequests extends BinaryServerRequestDefs = {},
>(
  declarations: BinaryDeclarations<TEmits, TRequests> = {},
  // `NoInfer`: without it, a channel's `capabilities` list would infer the maps from the
  // return type, so a `binary()` with no `emits` would declare every name.
): BinaryCapability<NoInfer<TEmits>, NoInfer<TRequests>> {
  assertConfigShape(declarations, BINARY_CONFIG, 'binary()');
  const emits = declarations.emits ?? ({} as TEmits);
  const emitted = Object.keys(emits).map((name) => outgoingFactory(name, { binary: true }));
  const requests = declarations.serverRequests ?? ({} as TRequests);
  for (const event of Object.keys(requests)) {
    assertValidLiveThingIdentifier(
      event,
      'binary({ serverRequests }) event name',
      WIRE_LIMITS.event,
    );
  }

  return stampKind(
    capability<BinarySlot<TEmits, TRequests>, never, 'binary'>([binaryRuntime(), ...emitted], {
      __channelBinaryEmits: emits,
      __binaryOutgoing: emitted,
      __binaryServerRequests: requests,
    }),
    CAPABILITY_KIND.binary,
  ) as BinaryCapability<TEmits, TRequests>;
}, CAPABILITY_KIND.binary);
