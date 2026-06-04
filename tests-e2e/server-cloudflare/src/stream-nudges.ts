import { server } from '@wskit/server-cloudflare';
import { streamNudgesHandler } from '@wskit/tests-e2e-handlers/stream-nudges';

export const StreamNudgesServer = server(streamNudgesHandler);
