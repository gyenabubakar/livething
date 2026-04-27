import { serve } from '@wskit/server-cloudflare';
import { binaryHandler } from './handler.ts';

export const BinaryServer = serve(binaryHandler);
