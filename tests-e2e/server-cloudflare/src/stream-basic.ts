import { bind } from '@livething/server-cloudflare';
import { streamBasicDefinition } from '@livething/tests-e2e-handlers/stream-basic';

export class StreamBasicServer extends bind(streamBasicDefinition) {}
