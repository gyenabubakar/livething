import { assertConfigShape } from '~/_define/capability-checks.ts';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { outgoing as outgoingFactory } from '~/outgoing/outgoing.ts';
import { definePrimitive } from '~/primitive.ts';
import type { Capability } from '~/_define/capability.ts';
import type { EmitDefs, EmitSlot } from '~/emits/emits.ts';
import type { Primitive } from '~/primitive.ts';
import { addBinarySenders, processBinaryMessage } from './runtime.ts';

/** What `binary({...})` declares for one scope. */
export interface BinaryDeclarations<TEmits extends EmitDefs = EmitDefs> {
  /**
   * The binary events this scope sends, as `name: t<Info>()`. The marker types the info,
   * which is JSON (a plain object or `null`). The bytes are not typed: they can be anything.
   */
  readonly emits?: TEmits;
}

/** The contract slot `binary({ emits })` declares: the binary events the client receives. */
export type BinarySlot<TEmits extends EmitDefs> = {
  binaryOutgoing: EmitSlot<TEmits>['outgoing'];
};

/**
 * The value `binary({...})` returns. List it in `server({ capabilities })` to turn binary
 * messages on, and in a channel's own `capabilities` for that channel's binary events.
 */
export type BinaryCapability<TEmits extends EmitDefs = {}> = Capability<
  BinarySlot<TEmits>,
  never,
  'binary'
> & {
  /** The declared binary events, read by the channel types. @internal */
  readonly __channelBinaryEmits: TEmits;
  /** The binary event primitives, which a channel puts in its own scope. @internal */
  readonly __binaryOutgoing: readonly Primitive[];
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

const BINARY_CONFIG = { hooks: [], options: ['emits'] };

/**
 * Turn binary messages on. A binary message carries JSON **info**, typed like any payload,
 * and raw **bytes** that no schema checks. List `binary()` at the root to accept binary
 * frames and get `base.binary.on(...)` and the `.binary` senders. Without it, a binary
 * frame closes the socket with `1003`.
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
export const binary = withCapabilityKind(function binary<const TEmits extends EmitDefs = {}>(
  declarations: BinaryDeclarations<TEmits> = {},
): BinaryCapability<TEmits> {
  assertConfigShape(declarations, BINARY_CONFIG, 'binary()');
  const emits = declarations.emits ?? ({} as TEmits);
  const emitted = Object.keys(emits).map((name) => outgoingFactory(name, { binary: true }));

  return stampKind(
    capability<BinarySlot<TEmits>, never, 'binary'>([binaryRuntime(), ...emitted], {
      __channelBinaryEmits: emits,
      __binaryOutgoing: emitted,
    }),
    CAPABILITY_KIND.binary,
  ) as BinaryCapability<TEmits>;
}, CAPABILITY_KIND.binary);
