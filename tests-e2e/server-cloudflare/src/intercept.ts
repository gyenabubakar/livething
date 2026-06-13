import { server } from '@wskit/server-cloudflare';
import { interceptHandler } from '@wskit/tests-e2e-handlers/intercept';

export const InterceptServer = server(interceptHandler);
