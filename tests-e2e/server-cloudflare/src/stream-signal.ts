import { server } from '@wskit/server-cloudflare';
import { streamSignalHandler } from '@wskit/tests-e2e-handlers/stream-signal';

export const StreamSignalServer = server(streamSignalHandler);
