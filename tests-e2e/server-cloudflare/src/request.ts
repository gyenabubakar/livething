import { server } from '@wskit/server-cloudflare';
import { requestHandler } from '@wskit/tests-e2e-handlers/request';

export const RequestServer = server(requestHandler);
