import { server } from '@wskit/server-cloudflare';
import { streamBackpressureHandler } from '@wskit/tests-e2e-handlers/stream-backpressure';

export const StreamBackpressureServer = server(streamBackpressureHandler);
