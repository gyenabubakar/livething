import { isValidWSKitIdentifier, ValidationFailed, WIRE_LIMITS } from '@wskit/core';
import type { WSKitError } from '@wskit/core';

type WireFieldKind = 'event' | 'channel' | 'streamId';

const FIELD_META: Record<WireFieldKind, { label: string; limit: number }> = {
  event: { label: 'event name', limit: WIRE_LIMITS.event },
  channel: { label: 'channel name', limit: WIRE_LIMITS.channel },
  streamId: { label: 'streamId', limit: WIRE_LIMITS.streamId },
};

/**
 * Reject a user-supplied wire identifier locally when it can't travel — empty,
 * not a string, or over the protocol limit. The server rejects such a frame
 * before it can route an error back, so the owning Promise would otherwise hang
 * to its timeout. `event` routes the returned `ValidationFailed`; returns `null`
 * when the value is ok.
 */
export function wireIdError(event: string, value: string, kind: WireFieldKind): WSKitError | null {
  const { label, limit } = FIELD_META[kind];
  if (typeof value !== 'string' || value.length === 0) {
    return ValidationFailed({
      event,
      issues: [{ message: `${label} must be a non-empty string.` }],
    });
  }
  if (kind === 'event' && isReservedEventName(value)) {
    return ValidationFailed({
      event,
      issues: [
        { message: `${label} '${value}' is reserved; it can't be used as a user event name.` },
      ],
    });
  }
  if (value.length > limit) {
    return ValidationFailed({
      event,
      issues: [{ message: `${label} is ${value.length} characters; the limit is ${limit}.` }],
    });
  }
  return null;
}

/**
 * True when `name` is a reserved protocol name that can't be a user event:
 * the bare `ping`/`pong` control frames, or anything in the engine's `__x__`
 * namespace (and an empty/non-string name).
 */
export function isReservedEventName(name: string): boolean {
  return name === 'ping' || name === 'pong' || !isValidWSKitIdentifier(name);
}

/**
 * A family key is optional — an absent (`undefined`) one is a static channel and
 * is fine. But a *supplied* family key must be a non-empty string within the
 * limit: an empty key would drop the `channelFamily` marker and turn the frame
 * into a static-channel subscribe that hangs.
 */
export function familyKeyError(event: string, familyKey: string | undefined): WSKitError | null {
  if (familyKey === undefined) return null;
  if (familyKey.length === 0) {
    return ValidationFailed({
      event,
      issues: [{ message: 'channel family must be a non-empty string when given.' }],
    });
  }
  if (familyKey.length > WIRE_LIMITS.channelFamily) {
    return ValidationFailed({
      event,
      issues: [
        { message: `channel family is over the ${WIRE_LIMITS.channelFamily}-character limit.` },
      ],
    });
  }
  return null;
}
