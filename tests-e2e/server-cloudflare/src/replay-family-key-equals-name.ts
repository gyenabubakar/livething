import { bind } from '@wskit/server-cloudflare';
import { replayFamilyKeyEqualsNameDefinition } from '@wskit/tests-e2e-handlers/replay-family-key-equals-name';

export class ReplayFamilyKeyEqualsNameServer extends bind(replayFamilyKeyEqualsNameDefinition) {}
