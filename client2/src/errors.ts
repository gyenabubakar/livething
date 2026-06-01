import { error } from '@wskit/core';

/** A pending `request()` or `send.withAck()` timed out. */
export const Timeout = error('timeout');

/** `disconnect()` was called while a `request()` or `send.withAck()` was waiting. */
export const Disconnected = error('disconnected');
