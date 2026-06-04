import { server } from '@wskit/server-cloudflare';
import { streamBasicHandler } from '@wskit/tests-e2e-handlers/stream-basic';

export const StreamBasicServer = server(streamBasicHandler);
