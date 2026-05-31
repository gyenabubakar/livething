import { server } from '@wskit/server-cloudflare';
import { hibernationHandler } from './handler.ts';

export const HibernationServer = server(hibernationHandler);
