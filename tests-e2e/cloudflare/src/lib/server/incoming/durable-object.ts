import { server } from '@wskit/server-cloudflare';
import { incomingHandler } from './handler.ts';

export const IncomingServer = server(incomingHandler);
