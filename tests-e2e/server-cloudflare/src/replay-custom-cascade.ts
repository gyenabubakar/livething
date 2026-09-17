import { bind } from '@wskit/server-cloudflare';
import { replayCustomCascadeHandler } from '@wskit/tests-e2e-handlers/replay-custom-cascade';

export class ReplayCustomCascadeServer extends bind(replayCustomCascadeHandler) {}
