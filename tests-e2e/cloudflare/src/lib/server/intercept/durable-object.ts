import { server } from '@wskit/server-cloudflare';
import { interceptHandler } from './handler.ts';

export const InterceptServer = server(interceptHandler);
