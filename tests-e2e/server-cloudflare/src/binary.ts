import { server } from '@wskit/server-cloudflare';
import { binaryHandler } from '@wskit/tests-e2e-handlers/binary';

export const BinaryServer = server(binaryHandler);
