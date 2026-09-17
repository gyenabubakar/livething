import { bind } from '@wskit/server-cloudflare';
import { broadcastRequestHandler } from '@wskit/tests-e2e-handlers/broadcast-request';

export class BroadcastRequestServer extends bind(broadcastRequestHandler) {}
