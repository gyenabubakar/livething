import { bind } from '@wskit/server-cloudflare';
import { streamNudgesHandler } from '@wskit/tests-e2e-handlers/stream-nudges';

export class StreamNudgesServer extends bind(streamNudgesHandler) {}
