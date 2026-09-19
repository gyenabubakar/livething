import { bind } from '@livething/server-cloudflare';
import { streamNudgesDefinition } from '@livething/tests-e2e-handlers/stream-nudges';

export class StreamNudgesServer extends bind(streamNudgesDefinition) {}
