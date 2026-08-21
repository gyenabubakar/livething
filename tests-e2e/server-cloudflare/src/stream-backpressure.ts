import { server } from '@wskit/server-cloudflare';
import { streamBackpressureHandler } from '@wskit/tests-e2e-handlers/stream-backpressure';

export class StreamBackpressureServer extends server(streamBackpressureHandler) {}
