import { bind } from '@wskit/server-cloudflare';
import { streamSignalHandler } from '@wskit/tests-e2e-handlers/stream-signal';

export class StreamSignalServer extends bind(streamSignalHandler) {}
