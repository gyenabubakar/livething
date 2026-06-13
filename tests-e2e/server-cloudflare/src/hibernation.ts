import { server } from '@wskit/server-cloudflare';
import { hibernationHandler } from './hibernation/handler.ts';

export const HibernationServer = server(hibernationHandler);
