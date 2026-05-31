import { server } from '@wskit/server-cloudflare';
import { multiStateHandler } from './handler.ts';

export const MultiStateServer = server(multiStateHandler);
