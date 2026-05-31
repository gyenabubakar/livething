import { server } from '@wskit/server-cloudflare';
import { ackHandler } from './handler.ts';

export const AckServer = server(ackHandler);
