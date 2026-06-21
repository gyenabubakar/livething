import { resolveChannel } from '~/_engine/runtime/scope.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';

declare const compiled: EngineCompileTypes.CompiledServer;

// Invariant lock: a routing envelope must always specify `channelFamily`
// (`string | null`) — an ABSENT family would let `channelFamily !== null`
// mis-route a static channel into the family branch. `channelFamily` is a
// REQUIRED field, so a static channel must carry an explicit `null`.

// @ts-expect-error — channelFamily is required; an absent family is not allowed.
resolveChannel(compiled, { channel: 'lobby' });

// A static channel carries explicit null; a family carries its key. Both ok.
resolveChannel(compiled, { channel: 'lobby', channelFamily: null });
resolveChannel(compiled, { channel: 'rooms:1', channelFamily: 'rooms' });

// No routing at all (top-level frame) is fine.
resolveChannel(compiled, undefined);
