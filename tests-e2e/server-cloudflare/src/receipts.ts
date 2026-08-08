import { server } from '@wskit/server-cloudflare';
import { receiptsHandler } from '@wskit/tests-e2e-handlers/receipts';

export class ReceiptsServer extends server(receiptsHandler) {}
