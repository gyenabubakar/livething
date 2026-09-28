import { bind } from '@livething/server-cloudflare';
import { protocolPingsDefinition } from '@livething/tests-e2e-handlers/protocol-pings';

export class ProtocolPingsServer extends bind(protocolPingsDefinition) {}
