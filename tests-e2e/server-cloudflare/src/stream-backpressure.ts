import { bind } from '@livething/server-cloudflare';
import { streamBackpressureDefinition } from '@livething/tests-e2e-handlers/stream-backpressure';

export class StreamBackpressureServer extends bind(streamBackpressureDefinition) {}
