import { bind } from '@wskit/server-cloudflare';
import { protocolPingsDefinition } from '@wskit/tests-e2e-handlers/protocol-pings';

export class ProtocolPingsServer extends bind(protocolPingsDefinition) {}
