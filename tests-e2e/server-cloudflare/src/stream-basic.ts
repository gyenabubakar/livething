import { bind } from '@wskit/server-cloudflare';
import { streamBasicDefinition } from '@wskit/tests-e2e-handlers/stream-basic';

export class StreamBasicServer extends bind(streamBasicDefinition) {}
