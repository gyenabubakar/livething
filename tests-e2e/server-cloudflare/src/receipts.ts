import { server } from '@wskit/server-cloudflare';
import { receiptsHandler } from '@wskit/tests-e2e-handlers/receipts';

export const ReceiptsServer = server(receiptsHandler);
