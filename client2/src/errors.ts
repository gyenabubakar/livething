import { error } from '@wskit/core';

/** A pending `request()` or `sendWithAck()` timed out. */
export const Timeout = error('timeout');

/** `disconnect()` was called while a `request()` or `sendWithAck()` was waiting. */
export const Disconnected = error('disconnected');
