import { server } from '@wskit/server-cloudflare';
import { binaryHandler } from './handler.ts';

export const BinaryServer = server(binaryHandler);
