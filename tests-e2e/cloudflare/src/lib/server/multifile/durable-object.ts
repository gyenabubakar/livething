import { server } from '@wskit/server-cloudflare';
import { multifileHandler } from './handler.ts';

export const MultifileServer = server(multifileHandler);
