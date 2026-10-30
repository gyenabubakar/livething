/**
 * The stream capabilities, grouped under one import path. List the ones you use
 * in `server({ capabilities: [...] })` to enable the matching `base.stream` and
 * `base.recordedStream` builders.
 */
export { stream } from './stream/capability.ts';
export type { StreamCapability } from './stream/capability.ts';
export { recordedStream } from './stream-recorded/capability.ts';
export type { RecordedStreamCapability } from './stream-recorded/capability.ts';
