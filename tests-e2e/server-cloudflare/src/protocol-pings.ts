import { server } from '@wskit/server-cloudflare';
import { protocolPingsHandler } from '@wskit/tests-e2e-handlers/protocol-pings';

export class ProtocolPingsServer extends server(protocolPingsHandler) {}
