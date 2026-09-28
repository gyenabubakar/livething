import { bind } from '@livething/server-cloudflare';
import { streamSignalDefinition } from '@livething/tests-e2e-handlers/stream-signal';

export class StreamSignalServer extends bind(streamSignalDefinition) {}
