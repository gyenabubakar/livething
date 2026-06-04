import { server } from '@wskit/server-cloudflare';
import { multifileHandler } from '@wskit/tests-e2e-handlers/multifile';

export const MultifileServer = server(multifileHandler);
