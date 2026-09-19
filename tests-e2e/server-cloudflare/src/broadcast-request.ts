import { bind } from '@livething/server-cloudflare';
import { broadcastRequestDefinition } from '@livething/tests-e2e-handlers/broadcast-request';

export class BroadcastRequestServer extends bind(broadcastRequestDefinition) {}
