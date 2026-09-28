import { bind } from '@livething/server-cloudflare';
import { replayCustomDefinition } from '@livething/tests-e2e-handlers/replay-custom';

export class ReplayCustomServer extends bind(replayCustomDefinition) {}
