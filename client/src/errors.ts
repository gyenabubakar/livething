import { error } from '@wskit/core';

/** A pending `request()` or `sendWithAck()` timed out. */
export const Timeout = /* @__PURE__ */ error('timeout');

/** `disconnect()` was called while a `request()` or `sendWithAck()` was waiting. */
export const Disconnected = /* @__PURE__ */ error('disconnected');

// Re-exported from @wskit/core so apps have one import for every runtime error.
export { error, WSKitError, Block, ValidationFailed } from '@wskit/core';
