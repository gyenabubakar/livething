import { bind } from '@livething/server-cloudflare';
import { replayDefinition } from '@livething/tests-e2e-handlers/replay-history';

export class ReplayServer extends bind(replayDefinition) {}
