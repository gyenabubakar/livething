import { server } from '@wskit/server-cloudflare';
import { rejectHttpHandler } from './handler.ts';

export const RejectHttpServer = server(rejectHttpHandler);
