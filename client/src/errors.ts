import { error } from '@wskit/core';

/** A pending `request()` timed out. */
export const Timeout = /* @__PURE__ */ error('timeout');

/** `disconnect()` was called while a `request()` was waiting. */
export const Disconnected = /* @__PURE__ */ error('disconnected');

/**
 * A buffered `request()` was dropped before it could be sent —
 * the buffer overflowed (its frame was evicted to make room) or its time-to-live
 * elapsed while offline. The owning Promise rejects with this instead of waiting
 * out its timeout for a frame that will never reach the wire.
 */
export const Dropped = /* @__PURE__ */ error('dropped');

export { error, WSKitError, Block, ValidationFailed } from '@wskit/core';
